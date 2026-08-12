// FILE: appPackaging.ts
// Purpose: Creates deterministic, validated Penkra App archives for runtime and release tooling.
// Layer: Shared Node-only App packaging utility

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  PENKRA_APP_INSTRUCTIONS_MAX_BYTES,
  PENKRA_APP_README_MAX_BYTES,
  assertAppManifest,
  type PenkraAppManifest,
} from "@penkra/sdk";
import { valid, validRange } from "semver";
import yazl from "yazl";

const MAX_ENTRY_COUNT = 2_048;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 1_024;
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const FORBIDDEN_EXECUTABLE_SUFFIXES = [
  ".app",
  ".bat",
  ".cmd",
  ".command",
  ".dmg",
  ".dll",
  ".dylib",
  ".exe",
  ".msi",
  ".node",
  ".pkg",
  ".ps1",
  ".sh",
  ".so",
] as const;

export interface AppPackageEvidence {
  path: string;
  appId: string;
  slug: string;
  name: string;
  summary: string;
  version: string;
  compatibilityRange: string;
  manifestDigest: string;
  readmeDigest: string;
  instructionsDigest: string;
  packageDigest: string;
  packageSizeBytes: number;
  permissions: ReadonlyArray<{ permission: string; required: boolean; rationale: string }>;
}

export async function packageAppDirectory(input: {
  directory: string;
  output: string;
}): Promise<AppPackageEvidence> {
  const root = await FS.realpath(Path.resolve(input.directory));
  const requestedOutput = Path.resolve(input.output);
  await FS.mkdir(Path.dirname(requestedOutput), { recursive: true });
  const output = Path.join(
    await FS.realpath(Path.dirname(requestedOutput)),
    Path.basename(requestedOutput),
  );
  if (isWithin(root, output)) {
    throw new Error("The App package output must be outside the packaged directory.");
  }
  const files = await readPackageFiles(root);
  const documents = requiredDocuments(files);
  const manifest = parseManifest(documents.manifest);
  assertReferencedFiles(manifest, files);

  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeArchive(temporary, files);
    await FS.rename(temporary, output);
  } catch (error) {
    await FS.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const packageBytes = await FS.readFile(output);
  return {
    path: output,
    appId: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    summary: manifest.summary,
    version: manifest.version,
    compatibilityRange: manifest.compatibility.penkra,
    manifestDigest: sha256(documents.manifest),
    readmeDigest: sha256(documents.readme),
    instructionsDigest: sha256(documents.instructions),
    packageDigest: sha256(packageBytes),
    packageSizeBytes: packageBytes.byteLength,
    permissions: (manifest.permissions ?? []).map((permission) => ({
      permission: permission.name,
      required: permission.required,
      rationale: permission.reason,
    })),
  };
}

type PackageFile = { path: string; bytes: Buffer };

async function readPackageFiles(root: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];
  const portablePaths = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await FS.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = Path.join(directory, entry.name);
      const relative = Path.relative(root, absolute).split(Path.sep).join("/").normalize("NFC");
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported package entry: ${relative}`);
      if (++fileCount > MAX_ENTRY_COUNT)
        throw new Error(`App packages may contain at most ${MAX_ENTRY_COUNT} files.`);
      if (Buffer.byteLength(relative, "utf8") > MAX_PATH_BYTES)
        throw new Error(`Package path is too long: ${relative}`);
      const portable = relative.toLocaleLowerCase("en-US");
      if (portablePaths.has(portable))
        throw new Error(`Package paths collide across filesystems: ${relative}`);
      portablePaths.add(portable);
      if (FORBIDDEN_EXECUTABLE_SUFFIXES.some((suffix) => portable.endsWith(suffix))) {
        throw new Error(`Native executables and scripts are not allowed: ${relative}`);
      }
      const bytes = await FS.readFile(absolute);
      if (bytes.byteLength > MAX_ENTRY_BYTES)
        throw new Error(`Package entry is too large: ${relative}`);
      if (executableFormat(bytes.subarray(0, 8)))
        throw new Error(`Native executable content is not allowed: ${relative}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error(`Expanded App package exceeds ${MAX_TOTAL_BYTES} bytes.`);
      files.push({ path: relative, bytes });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function requiredDocuments(files: PackageFile[]): {
  manifest: Buffer;
  readme: Buffer;
  instructions: Buffer;
} {
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  const manifest = requireDocument(byPath, "penkra-app.json", MAX_MANIFEST_BYTES, false);
  const readme = requireDocument(byPath, "README.md", PENKRA_APP_README_MAX_BYTES, true);
  const instructions = requireDocument(
    byPath,
    "INSTRUCTIONS.md",
    PENKRA_APP_INSTRUCTIONS_MAX_BYTES,
    true,
  );
  return { manifest, readme, instructions };
}

function requireDocument(
  files: Map<string, Buffer>,
  path: string,
  maximumBytes: number,
  requireText: boolean,
): Buffer {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`${path} is required at the App package root.`);
  if (bytes.byteLength > maximumBytes) throw new Error(`${path} exceeds ${maximumBytes} bytes.`);
  if (requireText) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || !text.trim())
      throw new Error(`${path} must be nonempty UTF-8 text.`);
  }
  return bytes;
}

function parseManifest(bytes: Buffer): PenkraAppManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `penkra-app.json is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertAppManifest(manifest);
  if (!valid(manifest.version)) throw new Error("App manifest version must be valid SemVer.");
  if (!validRange(manifest.compatibility.penkra)) {
    throw new Error("App manifest compatibility.penkra must be a valid SemVer range.");
  }
  return manifest;
}

function assertReferencedFiles(manifest: PenkraAppManifest, files: PackageFile[]): void {
  const paths = new Set(files.map((file) => file.path));
  const references = [
    manifest.entrypoints.app,
    manifest.entrypoints.operations,
    ...manifest.icons.map((icon) => icon.src),
    ...(manifest.contributions?.skills ?? []).map((skill) => `${skill.path}/SKILL.md`),
  ].filter((path): path is string => Boolean(path));
  for (const reference of references) {
    if (!paths.has(reference))
      throw new Error(`Manifest reference is missing from the package: ${reference}`);
  }
}

async function writeArchive(path: string, files: PackageFile[]): Promise<void> {
  const archive = new yazl.ZipFile();
  for (const file of files) {
    archive.addBuffer(file.bytes, file.path, { mtime: ZIP_EPOCH, mode: 0o100644, compress: true });
  }
  archive.end();
  await pipeline(archive.outputStream, createWriteStream(path, { flags: "wx", mode: 0o600 }));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = Path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${Path.sep}`) && relative !== "..");
}

function executableFormat(header: Buffer): boolean {
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    return true;
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return true;
  if (header.length < 4) return false;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
    header.readUInt32BE(0),
  );
}

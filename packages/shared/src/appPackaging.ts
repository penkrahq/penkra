// FILE: appPackaging.ts
// Purpose: Creates deterministic, validated Penkra App archives for runtime and release tooling.
// Layer: Shared Node-only App packaging utility

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  PENKRA_APP_INSTRUCTIONS_MAX_BYTES,
  PENKRA_APP_README_MAX_BYTES,
  assertPublishableAppManifest,
  type PenkraAppManifest,
} from "@penkra/sdk";
import Ajv2020 from "ajv/dist/2020.js";
import { valid, validRange } from "semver";
import yazl from "yazl";
import {
  PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES,
  PENKRA_APP_PACKAGE_MAX_EXPANDED_BYTES,
  PENKRA_APP_PACKAGE_MAX_FILES,
} from "./appPackageLimits";

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
  permissions: ReadonlyArray<{
    permission: string;
    required: boolean;
    rationale: string;
    audience?: string;
  }>;
}

export async function packageAppDirectory(input: {
  directory: string;
  output: string;
}): Promise<AppPackageEvidence> {
  return packageAppDirectoryWithPolicy(input, true);
}

/**
 * Reproduces an immutable, digest-locked App release that predates the current authoring contract.
 * Callers must verify the returned identity and digest against a trusted release lock.
 */
export async function packageLockedAppDirectory(input: {
  directory: string;
  output: string;
}): Promise<AppPackageEvidence> {
  return packageAppDirectoryWithPolicy(input, false);
}

async function packageAppDirectoryWithPolicy(
  input: { directory: string; output: string },
  requireCurrentAgentInstructions: boolean,
): Promise<AppPackageEvidence> {
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
  const documents = await requiredDocuments(files);
  const manifest = parseManifest(documents.manifest);
  if (requireCurrentAgentInstructions) {
    assertAgentInstructionsContract(manifest, documents.instructions);
  }
  await assertReferencedFiles(manifest, files);

  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeArchive(temporary, files);
    if ((await FS.stat(temporary)).size > PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES) {
      throw new Error(`App package archive exceeds ${PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES} bytes.`);
    }
    await FS.rename(temporary, output);
  } catch (error) {
    await FS.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const packageStat = await FS.stat(output);
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
    packageDigest: await sha256File(output),
    packageSizeBytes: packageStat.size,
    permissions: (manifest.permissions ?? []).map((permission) => ({
      permission: permission.name,
      required: permission.required,
      rationale: permission.reason,
      ...(permission.audience ? { audience: permission.audience } : {}),
    })),
  };
}

type PackageFile = { path: string; sourcePath: string; size: number };

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
      if (++fileCount > PENKRA_APP_PACKAGE_MAX_FILES)
        throw new Error(`App packages may contain at most ${PENKRA_APP_PACKAGE_MAX_FILES} files.`);
      if (Buffer.byteLength(relative, "utf8") > MAX_PATH_BYTES)
        throw new Error(`Package path is too long: ${relative}`);
      const portable = relative.toLocaleLowerCase("en-US");
      if (portablePaths.has(portable))
        throw new Error(`Package paths collide across filesystems: ${relative}`);
      portablePaths.add(portable);
      if (FORBIDDEN_EXECUTABLE_SUFFIXES.some((suffix) => portable.endsWith(suffix))) {
        throw new Error(`Native executables and scripts are not allowed: ${relative}`);
      }
      const stat = await FS.stat(absolute);
      const header = await readPrefix(absolute, 8);
      if (executableFormat(header))
        throw new Error(`Native executable content is not allowed: ${relative}`);
      totalBytes += stat.size;
      if (totalBytes > PENKRA_APP_PACKAGE_MAX_EXPANDED_BYTES)
        throw new Error(
          `Expanded App package exceeds ${PENKRA_APP_PACKAGE_MAX_EXPANDED_BYTES} bytes.`,
        );
      files.push({ path: relative, sourcePath: absolute, size: stat.size });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function requiredDocuments(files: PackageFile[]): Promise<{
  manifest: Buffer;
  readme: Buffer;
  instructions: Buffer;
}> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifest = await requireDocument(byPath, "penkra-app.json", MAX_MANIFEST_BYTES, false);
  const readme = await requireDocument(byPath, "README.md", PENKRA_APP_README_MAX_BYTES, true);
  const instructions = await requireDocument(
    byPath,
    "INSTRUCTIONS.md",
    PENKRA_APP_INSTRUCTIONS_MAX_BYTES,
    true,
  );
  return { manifest, readme, instructions };
}

async function requireDocument(
  files: Map<string, PackageFile>,
  path: string,
  maximumBytes: number,
  requireText: boolean,
): Promise<Buffer> {
  const file = files.get(path);
  if (!file) throw new Error(`${path} is required at the App package root.`);
  if (file.size > maximumBytes) throw new Error(`${path} exceeds ${maximumBytes} bytes.`);
  const bytes = await FS.readFile(file.sourcePath);
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
  assertPublishableAppManifest(manifest);
  assertOperationExamplesMatchSchemas(manifest);
  if (!valid(manifest.version)) throw new Error("App manifest version must be valid SemVer.");
  if (!validRange(manifest.compatibility.penkra)) {
    throw new Error("App manifest compatibility.penkra must be a valid SemVer range.");
  }
  return manifest;
}

function assertOperationExamplesMatchSchemas(manifest: PenkraAppManifest): void {
  const ajv = new Ajv2020({ allErrors: false, strict: true, validateFormats: false });
  for (const operation of manifest.operations ?? []) {
    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(operation.input);
    } catch (error) {
      throw new Error(`Operation ${operation.key} contains an invalid input schema.`, {
        cause: error,
      });
    }
    for (const [index, example] of operation.examples.entries()) {
      if (validate(example.input)) continue;
      const issue = validate.errors?.[0];
      throw new Error(
        `Operation ${operation.key} example ${index + 1} (${JSON.stringify(example.name)}) does not match its input schema${issue ? ` at ${issue.instancePath || "$"}: ${issue.message ?? issue.keyword}` : ""}.`,
      );
    }
  }
}

const REQUIRED_AGENT_INSTRUCTION_SECTIONS = [
  "What this App is",
  "Before you write anything",
  "How to do the common thing",
  "Reference",
  "When things fail",
] as const;

function assertAgentInstructionsContract(manifest: PenkraAppManifest, instructions: Buffer): void {
  if ((manifest.operations?.length ?? 0) === 0) return;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(instructions);
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = REQUIRED_AGENT_INSTRUCTION_SECTIONS.filter(
    (section) => !lines.has(`## ${section}`),
  );
  if (missing.length > 0) {
    throw new Error(
      `INSTRUCTIONS.md for an App with operations is missing required sections: ${missing.map((section) => `## ${section}`).join(", ")}. Add all five sections in the documented order.`,
    );
  }
  const positions = REQUIRED_AGENT_INSTRUCTION_SECTIONS.map((section) =>
    text.indexOf(`## ${section}`),
  );
  if (positions.some((position, index) => index > 0 && position < positions[index - 1]!)) {
    throw new Error(
      "INSTRUCTIONS.md must place the five required sections in the documented order: what it is, preconditions, common workflow, reference, then failures.",
    );
  }
}

async function assertReferencedFiles(
  manifest: PenkraAppManifest,
  files: PackageFile[],
): Promise<void> {
  const paths = new Set(files.map((file) => file.path));
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const references = [
    manifest.entrypoints.tab,
    manifest.entrypoints.controller,
    ...manifest.icons.map((icon) => icon.src),
    ...(manifest.contributions?.skills ?? []).map((skill) => `${skill.path}/SKILL.md`),
  ].filter((path): path is string => Boolean(path));
  for (const reference of references) {
    if (!paths.has(reference))
      throw new Error(`Manifest reference is missing from the package: ${reference}`);
  }
  for (const skill of manifest.contributions?.skills ?? []) {
    const skillPath = `${skill.path}/SKILL.md`;
    const bytes = await FS.readFile(filesByPath.get(skillPath)!.sourcePath);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(
        `${skillPath} must be UTF-8 text: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (text.includes("\0") || !text.trim()) {
      throw new Error(`${skillPath} must contain nonempty Agent Skill instructions.`);
    }
  }
}

async function writeArchive(path: string, files: PackageFile[]): Promise<void> {
  const archive = new yazl.ZipFile();
  for (const file of files) {
    // Store bytes without deflate so Bun, Node, Electron, and CI produce the same archive.
    // Compression output can vary with the runtime's zlib build even when every input is identical.
    archive.addFile(file.sourcePath, file.path, {
      mtime: ZIP_EPOCH,
      mode: 0o100644,
      compress: false,
    });
  }
  archive.end();
  await pipeline(archive.outputStream, createWriteStream(path, { flags: "wx", mode: 0o600 }));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function readPrefix(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await FS.open(path, "r");
  try {
    const bytes = Buffer.alloc(maximumBytes);
    const { bytesRead } = await handle.read(bytes, 0, maximumBytes, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
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

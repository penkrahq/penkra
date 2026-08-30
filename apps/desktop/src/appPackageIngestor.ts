// FILE: appPackageIngestor.ts
// Purpose: Validates and atomically commits immutable unpacked App packages.
// Layer: Trusted desktop App package boundary

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry } from "yauzl";
import {
  PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES,
  PENKRA_APP_PACKAGE_MAX_EXPANDED_BYTES,
  PENKRA_APP_PACKAGE_MAX_FILES,
} from "@penkra/shared/appPackageLimits";

import {
  assertPublishableAppManifest,
  PENKRA_APP_INSTRUCTIONS_MAX_BYTES,
  PENKRA_APP_README_MAX_BYTES,
  type PenkraAppManifest,
} from "@penkra/sdk";

import type { InstalledAppSource, VerifiedAppPackageInput } from "./appInstallationState";
import { assertOperationSchemas } from "./appOperationSchema";

export const PENKRA_APP_MANIFEST_FILE_NAME = "penkra-app.json";
export const APP_PACKAGE_MAX_FILES = PENKRA_APP_PACKAGE_MAX_FILES;
export const APP_PACKAGE_MAX_BYTES = PENKRA_APP_PACKAGE_MAX_EXPANDED_BYTES;

interface PackageFile {
  relativePath: string;
  sourcePath: string;
  size: number;
}

export interface AppPackageGarbageCollectionResult {
  removedPaths: string[];
  failures: Array<{ path: string; error: Error }>;
}

export function resolveAppPackageStorePath(userDataPath: string): string {
  return Path.join(userDataPath, "apps", "packages");
}

export class AppPackageIngestor {
  readonly #storePath: string;

  constructor(storePath: string) {
    if (!Path.isAbsolute(storePath))
      throw new TypeError("App package store path must be absolute.");
    this.#storePath = storePath;
  }

  /**
   * Removes package-store entries that are not referenced by committed state.
   *
   * This is intentionally a startup operation: callers run it after update
   * journal recovery and before accepting installs, so an ingested package
   * cannot be mistaken for garbage while it is waiting to be committed.
   */
  async collectGarbage(
    retainedPackagePaths: readonly string[],
  ): Promise<AppPackageGarbageCollectionResult> {
    const retained = new Set(
      retainedPackagePaths.map((packagePath) => {
        const resolved = Path.resolve(packagePath);
        assertPackagePathInsideStore(this.#storePath, resolved);
        return resolved;
      }),
    );
    const result: AppPackageGarbageCollectionResult = { removedPaths: [], failures: [] };
    for (const appEntry of await readDirectorySafe(this.#storePath)) {
      const appPath = Path.join(this.#storePath, appEntry.name);
      if (!appEntry.isDirectory() || appEntry.isSymbolicLink()) {
        await removeGarbagePath(appPath, result);
        continue;
      }
      for (const versionEntry of await readDirectorySafe(appPath)) {
        const versionPath = Path.join(appPath, versionEntry.name);
        if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink()) {
          await removeGarbagePath(versionPath, result);
          continue;
        }
        for (const packageEntry of await readDirectorySafe(versionPath)) {
          const packagePath = Path.join(versionPath, packageEntry.name);
          if (!retained.has(Path.resolve(packagePath)))
            await removeGarbagePath(packagePath, result);
        }
        await removeEmptyDirectory(versionPath, result);
      }
      await removeEmptyDirectory(appPath, result);
    }
    return result;
  }

  async ingestDirectory(input: {
    sourcePath: string;
    source: InstalledAppSource;
    installedAt?: string;
  }): Promise<VerifiedAppPackageInput> {
    const sourcePath = Path.resolve(input.sourcePath);
    const files = await collectPackageFiles(sourcePath);
    const manifest = await readManifest(sourcePath);
    assertOperationSchemas(manifest);
    await assertTextDocument(sourcePath, "README.md", PENKRA_APP_README_MAX_BYTES);
    await assertTextDocument(sourcePath, "INSTRUCTIONS.md", PENKRA_APP_INSTRUCTIONS_MAX_BYTES);
    for (const operation of manifest.operations ?? []) {
      if (operation.instructionsPath) {
        await assertTextDocument(
          sourcePath,
          operation.instructionsPath,
          PENKRA_APP_INSTRUCTIONS_MAX_BYTES,
        );
      }
    }
    assertRequiredFiles(files, manifest);
    const sha256 = await digestFiles(files);
    const packagePath = Path.join(this.#storePath, manifest.id, manifest.version, sha256);
    await commitPackage(files, packagePath, sha256);
    return {
      manifest,
      source: input.source,
      packagePath,
      sha256,
      installedAt: input.installedAt ?? new Date().toISOString(),
    };
  }

  async ingestRegistryArchive(input: {
    archivePath: string;
    expectedArchiveDigest: string;
    installedAt?: string;
  }): Promise<VerifiedAppPackageInput> {
    const archivePath = Path.resolve(input.archivePath);
    const archive = await FS.promises.stat(archivePath);
    if (
      !archive.isFile() ||
      archive.size === 0 ||
      archive.size > PENKRA_APP_PACKAGE_MAX_ARCHIVE_BYTES
    ) {
      throw new Error("Registry App package exceeds the archive size limit.");
    }
    const actualDigest = await digestFile(archivePath);
    if (actualDigest !== input.expectedArchiveDigest) {
      throw new Error("Registry App package digest changed before ingestion.");
    }
    const temporaryRoot = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-registry-app-"));
    const sourcePath = Path.join(temporaryRoot, "unpacked");
    try {
      await extractRegistryArchive(archivePath, sourcePath, this.#storePath);
      return await this.ingestDirectory({
        sourcePath,
        source: "registry",
        ...(input.installedAt === undefined ? {} : { installedAt: input.installedAt }),
      });
    } finally {
      await FS.promises.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function assertPackagePathInsideStore(storePath: string, packagePath: string): void {
  const relative = Path.relative(Path.resolve(storePath), packagePath);
  if (
    relative.startsWith("..") ||
    Path.isAbsolute(relative) ||
    relative.split(Path.sep).length !== 3
  ) {
    throw new Error(
      "Retained App package path is outside the package store or has an invalid shape.",
    );
  }
}

async function readDirectorySafe(directoryPath: string): Promise<FS.Dirent[]> {
  try {
    return await FS.promises.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function removeGarbagePath(
  garbagePath: string,
  result: AppPackageGarbageCollectionResult,
): Promise<void> {
  try {
    await FS.promises.rm(garbagePath, { recursive: true, force: true });
    result.removedPaths.push(garbagePath);
  } catch (error) {
    result.failures.push({ path: garbagePath, error: toError(error) });
  }
}

async function removeEmptyDirectory(
  directoryPath: string,
  result: AppPackageGarbageCollectionResult,
): Promise<void> {
  try {
    await FS.promises.rmdir(directoryPath);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) return;
    result.failures.push({ path: directoryPath, error: toError(error) });
  }
}

async function extractRegistryArchive(
  archivePath: string,
  outputRoot: string,
  storePath: string,
): Promise<void> {
  await FS.promises.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await FS.promises.mkdir(storePath, { recursive: true, mode: 0o700 });
  const zip = await yauzl.openPromise(archivePath, {
    autoClose: false,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    const entries: Array<{ entry: Entry; relativePath: string; isDirectory: boolean }> = [];
    const paths = new Set<string>();
    let fileCount = 0;
    let totalBytes = 0;
    for await (const entry of zip.eachEntry()) {
      const relativePath = entry.fileName.normalize("NFC");
      const isDirectory = relativePath.endsWith("/");
      const normalizedPath = isDirectory ? relativePath.slice(0, -1) : relativePath;
      assertPortableArchivePath(normalizedPath);
      const portablePath = normalizedPath.toLocaleLowerCase("en-US");
      if (paths.has(portablePath))
        throw new Error("Registry App package contains duplicate paths.");
      paths.add(portablePath);
      if (entry.isEncrypted()) throw new Error("Registry App package contains encrypted files.");
      if (isSymbolicLink(entry)) throw new Error("Registry App package contains a symbolic link.");
      if (!isDirectory) {
        fileCount += 1;
        if (fileCount > APP_PACKAGE_MAX_FILES) {
          throw new Error("Registry App package exceeds the file count limit.");
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > PENKRA_APP_PACKAGE_MAX_EXPANDED_BYTES) {
          throw new Error("Registry App package exceeds the unpacked size limit.");
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          throw new Error("Registry App package uses an unsupported compression method.");
        }
      }
      entries.push({ entry, relativePath: normalizedPath, isDirectory });
    }
    await assertInstallDiskSpace(outputRoot, storePath, totalBytes);
    for (const { entry, relativePath, isDirectory } of entries) {
      const outputPath = Path.join(outputRoot, ...relativePath.split("/"));
      if (isDirectory) {
        await FS.promises.mkdir(outputPath, { recursive: true, mode: 0o700 });
        continue;
      }
      await FS.promises.mkdir(Path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, FS.createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    }
  } finally {
    zip.close();
  }
}

async function assertInstallDiskSpace(
  extractionPath: string,
  storePath: string,
  expandedBytes: number,
): Promise<void> {
  const headroom = Math.max(256 * 1024 * 1024, Math.ceil(expandedBytes * 0.1));
  const targets = await Promise.all(
    (
      [
        ["temporary extraction", extractionPath],
        ["App package store", storePath],
      ] as const
    ).map(async ([label, path]) => ({
      label,
      path,
      device: String((await FS.promises.stat(path)).dev),
      filesystem: await FS.promises.statfs(path),
    })),
  );
  const byDevice = new Map<
    string,
    { labels: string[]; filesystem: Awaited<ReturnType<typeof FS.promises.statfs>>; bytes: number }
  >();
  for (const target of targets) {
    const requirement = byDevice.get(target.device) ?? {
      labels: [],
      filesystem: target.filesystem,
      bytes: headroom,
    };
    requirement.labels.push(target.label);
    requirement.bytes += expandedBytes;
    byDevice.set(target.device, requirement);
  }
  for (const requirement of byDevice.values()) {
    const availableBytes =
      BigInt(requirement.filesystem.bavail) * BigInt(requirement.filesystem.bsize);
    const requiredBytes = BigInt(requirement.bytes);
    if (availableBytes < requiredBytes) {
      throw new Error(
        `Not enough disk space for App installation ${requirement.labels.join(" and ")}: ${requiredBytes} bytes required, ${availableBytes} bytes available.`,
      );
    }
  }
}

async function digestFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of FS.createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function assertPortableArchivePath(value: string): void {
  if (
    !value ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Registry App package contains an unsafe path.");
  }
}

function isSymbolicLink(entry: Entry): boolean {
  if (entry.versionMadeBy >>> 8 !== 3) return false;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

async function readManifest(sourcePath: string): Promise<PenkraAppManifest> {
  const manifestPath = Path.join(sourcePath, PENKRA_APP_MANIFEST_FILE_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await FS.promises.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${PENKRA_APP_MANIFEST_FILE_NAME}.`, { cause: error });
  }
  assertPublishableAppManifest(parsed);
  return parsed;
}

async function assertTextDocument(
  sourcePath: string,
  fileName: string,
  maxBytes: number,
): Promise<void> {
  const filePath = Path.join(sourcePath, fileName);
  let bytes: Buffer;
  try {
    const stats = await FS.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
      throw new Error(`${fileName} is not a valid bounded file.`);
    }
    bytes = await FS.promises.readFile(filePath);
  } catch (error) {
    throw new Error(`Unable to read ${fileName}.`, { cause: error });
  }
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${fileName} must be valid UTF-8.`, { cause: error });
  }
  if (!contents.trim()) throw new Error(`${fileName} must not be empty.`);
}

async function collectPackageFiles(sourcePath: string): Promise<PackageFile[]> {
  const rootStats = await FS.promises.lstat(sourcePath);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("App package source must be a real directory.");
  }
  const files: PackageFile[] = [];
  let totalBytes = 0;
  const visit = async (directoryPath: string): Promise<void> => {
    const entries = await FS.promises.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourceEntryPath = Path.join(directoryPath, entry.name);
      const stats = await FS.promises.lstat(sourceEntryPath);
      if (stats.isSymbolicLink()) throw new Error("App packages cannot contain symbolic links.");
      if (stats.isDirectory()) {
        await visit(sourceEntryPath);
        continue;
      }
      if (!stats.isFile()) throw new Error("App packages may contain only files and directories.");
      totalBytes += stats.size;
      if (files.length + 1 > APP_PACKAGE_MAX_FILES || totalBytes > APP_PACKAGE_MAX_BYTES) {
        throw new Error("App package exceeds the unpacked size limit.");
      }
      files.push({
        relativePath: Path.relative(sourcePath, sourceEntryPath).split(Path.sep).join("/"),
        sourcePath: sourceEntryPath,
        size: stats.size,
      });
    }
  };
  await visit(sourcePath);
  return files;
}

function assertRequiredFiles(files: readonly PackageFile[], manifest: PenkraAppManifest): void {
  const paths = new Set(files.map((file) => file.relativePath));
  const required = new Set([
    PENKRA_APP_MANIFEST_FILE_NAME,
    "README.md",
    "INSTRUCTIONS.md",
    manifest.entrypoints.tab,
    ...(manifest.entrypoints.controller ? [manifest.entrypoints.controller] : []),
    ...manifest.icons.map((icon) => icon.src),
    ...(manifest.operations ?? []).flatMap((operation) =>
      operation.instructionsPath ? [operation.instructionsPath] : [],
    ),
    ...(manifest.contributions?.skills ?? []).map((skill) => `${skill.path}/SKILL.md`),
  ]);
  for (const relativePath of required) {
    if (!paths.has(relativePath)) throw new Error(`App package is missing ${relativePath}.`);
  }
}

async function digestFiles(files: readonly PackageFile[]): Promise<string> {
  const digest = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    const pathLengthBytes = Buffer.allocUnsafe(4);
    pathLengthBytes.writeUInt32BE(pathBytes.length);
    const sizeBytes = Buffer.allocUnsafe(8);
    sizeBytes.writeBigUInt64BE(BigInt(file.size));
    digest.update(pathLengthBytes);
    digest.update(sizeBytes);
    digest.update(pathBytes);
    for await (const chunk of FS.createReadStream(file.sourcePath)) digest.update(chunk);
  }
  return digest.digest("hex");
}

async function commitPackage(
  files: readonly PackageFile[],
  destinationPath: string,
  expectedDigest: string,
): Promise<void> {
  try {
    const stats = await FS.promises.stat(destinationPath);
    if (!stats.isDirectory()) throw new Error("Committed App package path is not a directory.");
    if ((await digestFiles(await collectPackageFiles(destinationPath))) !== expectedDigest) {
      throw new Error("Committed App package bytes do not match their immutable digest.");
    }
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  const parentPath = Path.dirname(destinationPath);
  const temporaryPath = Path.join(
    parentPath,
    `.package.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await FS.promises.mkdir(temporaryPath, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const outputPath = Path.join(temporaryPath, ...file.relativePath.split("/"));
      await FS.promises.mkdir(Path.dirname(outputPath), { recursive: true, mode: 0o700 });
      await FS.promises.copyFile(file.sourcePath, outputPath, FS.constants.COPYFILE_EXCL);
      await FS.promises.chmod(outputPath, 0o600);
    }
    await FS.promises.mkdir(parentPath, { recursive: true, mode: 0o700 });
    try {
      await FS.promises.rename(temporaryPath, destinationPath);
    } catch (error) {
      if (!isNodeError(error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) {
        throw error;
      }
    }
    if ((await digestFiles(await collectPackageFiles(destinationPath))) !== expectedDigest) {
      throw new Error("Committed App package bytes do not match their immutable digest.");
    }
  } finally {
    await FS.promises.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

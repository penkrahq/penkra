// FILE: appPackageIngestor.ts
// Purpose: Validates and atomically commits immutable unpacked App packages.
// Layer: Trusted desktop App package boundary

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { assertAppManifest, type PenkraAppManifest } from "@penkra/sdk";

import type { InstalledAppSource, VerifiedAppPackageInput } from "./appInstallationState";

export const PENKRA_APP_MANIFEST_FILE_NAME = "penkra-app.json";
export const APP_PACKAGE_MAX_FILES = 2_048;
export const APP_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;

interface PackageFile {
  relativePath: string;
  sourcePath: string;
  size: number;
}

export function resolveAppPackageStorePath(userDataPath: string): string {
  return Path.join(userDataPath, "apps", "packages");
}

export class AppPackageIngestor {
  readonly #storePath: string;

  constructor(storePath: string) {
    if (!Path.isAbsolute(storePath)) throw new TypeError("App package store path must be absolute.");
    this.#storePath = storePath;
  }

  async ingestDirectory(input: {
    sourcePath: string;
    source: InstalledAppSource;
    installedAt?: string;
  }): Promise<VerifiedAppPackageInput> {
    const sourcePath = Path.resolve(input.sourcePath);
    const files = await collectPackageFiles(sourcePath);
    const manifest = await readManifest(sourcePath);
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
}

async function readManifest(sourcePath: string): Promise<PenkraAppManifest> {
  const manifestPath = Path.join(sourcePath, PENKRA_APP_MANIFEST_FILE_NAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await FS.promises.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${PENKRA_APP_MANIFEST_FILE_NAME}.`, { cause: error });
  }
  assertAppManifest(parsed);
  return parsed;
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
    manifest.entrypoints.app,
    ...(manifest.entrypoints.operations ? [manifest.entrypoints.operations] : []),
    ...manifest.icons.map((icon) => icon.src),
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
    digest.update(await FS.promises.readFile(file.sourcePath));
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

// FILE: appScopedFileAccess.ts
// Purpose: Implements path-safe file operations beneath one App/Space-scoped handle.
// Layer: Trusted desktop App filesystem boundary

import * as FS from "node:fs";
import * as Path from "node:path";

export const APP_FILE_BINARY_CHUNK_MAX_BYTES = 8 * 1024 * 1024;

export interface ScopedRootHandle {
  id: string;
  kind: "file" | "directory";
  path: string;
  name: string;
}

export interface AppFileMetadata {
  name: string;
  kind: "file" | "directory";
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export async function statScopedPath(
  root: ScopedRootHandle,
  relativePath?: string,
): Promise<AppFileMetadata> {
  const path = await resolveExistingScopedPath(root, relativePath);
  const stats = await FS.promises.stat(path);
  return metadata(root, path, stats);
}

export async function listScopedDirectory(
  root: ScopedRootHandle,
  relativePath?: string,
): Promise<ReadonlyArray<AppFileMetadata>> {
  const directory = await resolveExistingScopedPath(root, relativePath);
  const stats = await FS.promises.stat(directory);
  if (!stats.isDirectory()) throw new Error("The requested App path is not a directory.");
  const entries = await FS.promises.readdir(directory, { withFileTypes: true });
  if (entries.length > 10_000) throw new Error("This directory contains too many entries.");
  const visible = entries.filter((entry) => entry.isFile() || entry.isDirectory());
  return Promise.all(
    visible.map(async (entry) => {
      const path = await FS.promises.realpath(Path.join(directory, entry.name));
      assertInsideRoot(root, path);
      return metadata(root, path, await FS.promises.stat(path));
    }),
  );
}

export async function readScopedBinary(input: {
  root: ScopedRootHandle;
  relativePath?: string;
  offset?: number;
  length?: number;
}): Promise<{ bytes: Uint8Array; offset: number; totalBytes: number; complete: boolean }> {
  const path = await resolveExistingScopedPath(input.root, input.relativePath);
  const stats = await FS.promises.stat(path);
  if (!stats.isFile()) throw new Error("The requested App path is not a file.");
  const offset = input.offset ?? 0;
  const length = Math.min(
    input.length ?? APP_FILE_BINARY_CHUNK_MAX_BYTES,
    APP_FILE_BINARY_CHUNK_MAX_BYTES,
  );
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1) {
    throw new Error("Binary range must use a non-negative offset and positive integer length.");
  }
  const bytesToRead = Math.max(0, Math.min(length, stats.size - offset));
  const bytes = Buffer.alloc(bytesToRead);
  const handle = await FS.promises.open(path, "r");
  try {
    if (bytesToRead > 0) await handle.read(bytes, 0, bytesToRead, offset);
  } finally {
    await handle.close();
  }
  return {
    bytes: new Uint8Array(bytes),
    offset,
    totalBytes: stats.size,
    complete: offset + bytesToRead >= stats.size,
  };
}

export async function writeScopedBinary(input: {
  root: ScopedRootHandle;
  relativePath?: string;
  bytes: Uint8Array;
}): Promise<void> {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength > APP_FILE_BINARY_CHUNK_MAX_BYTES
  ) {
    throw new Error("Binary writes must contain at most 8 MiB.");
  }
  const path = await resolveExistingScopedPath(input.root, input.relativePath);
  const stats = await FS.promises.stat(path);
  if (!stats.isFile()) throw new Error("The requested App path is not a file.");
  await FS.promises.writeFile(path, input.bytes);
}

export async function createScopedDirectory(
  root: ScopedRootHandle,
  relativePath: string,
): Promise<AppFileMetadata> {
  const path = await resolveProspectiveScopedPath(root, relativePath);
  await FS.promises.mkdir(path);
  return statScopedPath(root, relativePath);
}

export async function renameScopedPath(
  root: ScopedRootHandle,
  relativePath: string,
  nextRelativePath: string,
): Promise<AppFileMetadata> {
  const source = await resolveExistingScopedPath(root, relativePath);
  if (source === root.path) throw new Error("The root App handle cannot be renamed.");
  const destination = await resolveProspectiveScopedPath(root, nextRelativePath);
  await FS.promises.rename(source, destination);
  return statScopedPath(root, nextRelativePath);
}

export async function removeScopedPath(
  root: ScopedRootHandle,
  relativePath: string,
): Promise<void> {
  const path = await resolveExistingScopedPath(root, relativePath);
  if (path === root.path) throw new Error("The root App handle cannot be removed.");
  const stats = await FS.promises.stat(path);
  if (stats.isDirectory()) await FS.promises.rmdir(path);
  else await FS.promises.unlink(path);
}

export async function resolveExistingScopedPath(
  root: ScopedRootHandle,
  relativePath?: string,
): Promise<string> {
  if (!relativePath || relativePath === ".") return root.path;
  if (root.kind !== "directory") throw new Error("A file handle has no child paths.");
  assertRelativePath(relativePath);
  const path = await FS.promises.realpath(Path.resolve(root.path, relativePath));
  assertInsideRoot(root, path);
  return path;
}

async function resolveProspectiveScopedPath(
  root: ScopedRootHandle,
  relativePath: string,
): Promise<string> {
  if (root.kind !== "directory") throw new Error("A file handle has no child paths.");
  assertRelativePath(relativePath);
  const unresolved = Path.resolve(root.path, relativePath);
  const parent = await FS.promises.realpath(Path.dirname(unresolved));
  assertInsideRoot(root, parent);
  const path = Path.join(parent, Path.basename(unresolved));
  assertInsideRoot(root, path);
  return path;
}

function metadata(root: ScopedRootHandle, path: string, stats: FS.Stats): AppFileMetadata {
  const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
  if (!kind) throw new Error("Only regular files and directories are supported.");
  return {
    name: Path.basename(path),
    kind,
    relativePath: path === root.path ? "." : Path.relative(root.path, path),
    size: kind === "file" ? stats.size : 0,
    modifiedAt: stats.mtime.toISOString(),
  };
}

function assertRelativePath(value: string): void {
  if (!value || Path.isAbsolute(value)) throw new Error("App paths must be relative.");
  const normalized = Path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${Path.sep}`)) {
    throw new Error("App path escapes its authorized handle.");
  }
}

function assertInsideRoot(root: ScopedRootHandle, path: string): void {
  if (root.kind === "file") {
    if (path !== root.path) throw new Error("App path escapes its authorized file handle.");
    return;
  }
  const relative = Path.relative(root.path, path);
  if (relative === ".." || relative.startsWith(`..${Path.sep}`) || Path.isAbsolute(relative)) {
    throw new Error("App path escapes its authorized directory handle.");
  }
}

// FILE: appScopedFilePaths.ts
// Purpose: Resolves opaque App file handles without permitting traversal or symlink escape.
// Layer: Trusted desktop App capability boundary

import * as FS from "node:fs";
import * as Path from "node:path";

export interface AppScopedPathRoot {
  kind: "file" | "directory";
  rootPath: string;
}

export function normalizeAppScopedRelativePath(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 4_096 || value.includes("\0")) {
    throw new Error("Relative path is invalid.");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error("Relative path must remain inside the selected resource.");
  }
  return normalized
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

export function appScopedCandidatePath(root: AppScopedPathRoot, value: unknown): string {
  const relativePath = normalizeAppScopedRelativePath(value);
  if (root.kind === "file") {
    if (relativePath) throw new Error("A file handle has no descendants.");
    return root.rootPath;
  }
  const candidate = Path.resolve(root.rootPath, relativePath);
  assertInsideRoot(root.rootPath, candidate, "Relative path escaped the selected directory.");
  return candidate;
}

export async function resolveExistingAppScopedPath(
  root: AppScopedPathRoot,
  value: unknown,
): Promise<string> {
  const resolved = await FS.promises.realpath(appScopedCandidatePath(root, value));
  assertInsideRoot(root.rootPath, resolved, "Symbolic link escaped the selected resource.");
  return resolved;
}

export async function resolveWritableAppScopedPath(
  root: AppScopedPathRoot,
  value: unknown,
): Promise<string> {
  const candidate = appScopedCandidatePath(root, value);
  try {
    const resolved = await FS.promises.realpath(candidate);
    assertInsideRoot(root.rootPath, resolved, "Symbolic link escaped the selected resource.");
    return resolved;
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = await FS.promises.realpath(Path.dirname(candidate));
    assertInsideRoot(root.rootPath, parent, "File destination escaped the selected directory.");
    return candidate;
  }
}

export async function appScopedFileEntry(
  root: AppScopedPathRoot,
  value: unknown,
): Promise<{
  kind: "file" | "directory";
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
}> {
  const resolved = await resolveExistingAppScopedPath(root, value);
  const stat = await FS.promises.stat(resolved);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error("Unsupported filesystem entry.");
  return {
    kind: stat.isDirectory() ? "directory" : "file",
    name: Path.basename(resolved),
    relativePath:
      resolved === root.rootPath
        ? ""
        : Path.relative(root.rootPath, resolved).split(Path.sep).join("/"),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function assertInsideRoot(rootPath: string, candidate: string, message: string): void {
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${Path.sep}`)) {
    throw new Error(message);
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

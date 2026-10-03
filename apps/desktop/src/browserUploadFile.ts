import * as FSP from "node:fs/promises";
import * as Path from "node:path";

/** Resolve explicit upload paths; relative paths retain their App-storage base. */
export async function resolveBrowserUploadFile(
  path: string,
  relativeBase: string,
): Promise<string> {
  if (!path.trim()) throw new Error("Browser upload requires a file path.");
  const resolved = await FSP.realpath(Path.resolve(relativeBase, path));
  if (!(await FSP.stat(resolved)).isFile()) {
    throw new Error("Browser upload path must name a regular file.");
  }
  return resolved;
}

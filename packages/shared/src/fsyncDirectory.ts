import * as fs from "node:fs";

/** Sync a renamed directory entry where the platform supports directory fsync. */
export function fsyncDirectory(dir: string): void {
  // Windows does not permit fsync on a directory handle. The file itself is
  // synced before rename; NTFS journals the directory metadata.
  if (process.platform === "win32") return;
  const handle = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

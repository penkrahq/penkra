// FILE: appScopedTextFile.ts
// Purpose: Provides bounded text reads and writes for App-scoped file capabilities.
// Layer: Trusted desktop App capability boundary

import * as FS from "node:fs";

export const APP_SCOPED_TEXT_FILE_MAX_BYTES = 32 * 1024 * 1024;

export async function readAppScopedTextFile(path: string): Promise<string> {
  const stat = await FS.promises.stat(path);
  assertAppScopedTextFileSize(stat.size);
  return FS.promises.readFile(path, "utf8");
}

export async function writeAppScopedTextFile(path: string, source: string): Promise<void> {
  assertAppScopedTextFileSize(Buffer.byteLength(source));
  await FS.promises.writeFile(path, source, "utf8");
}

function assertAppScopedTextFileSize(bytes: number): void {
  if (bytes > APP_SCOPED_TEXT_FILE_MAX_BYTES) {
    throw new Error("Text file exceeds the 32 MB limit.");
  }
}

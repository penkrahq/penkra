import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APP_SCOPED_TEXT_FILE_MAX_BYTES,
  readAppScopedTextFile,
  writeAppScopedTextFile,
} from "./appScopedTextFile";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe("App-scoped text files", () => {
  it("round-trips text larger than the former 16 MB limit", async () => {
    const path = await temporaryFile("document.pen");
    const source = "x".repeat(16 * 1024 * 1024 + 1);

    await writeAppScopedTextFile(path, source);

    await expect(readAppScopedTextFile(path)).resolves.toBe(source);
  });

  it("rejects reads and writes larger than the 32 MB limit", async () => {
    const path = await temporaryFile("oversized.pen");
    await FS.promises.truncate(path, APP_SCOPED_TEXT_FILE_MAX_BYTES + 1);

    await expect(readAppScopedTextFile(path)).rejects.toThrow("32 MB limit");
    await expect(
      writeAppScopedTextFile(path, "x".repeat(APP_SCOPED_TEXT_FILE_MAX_BYTES + 1)),
    ).rejects.toThrow("32 MB limit");
  });
});

async function temporaryFile(name: string): Promise<string> {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-text-file-"));
  temporaryDirectories.push(directory);
  const path = Path.join(directory, name);
  await FS.promises.writeFile(path, "");
  return path;
}

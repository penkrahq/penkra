import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appScopedFileEntry,
  normalizeAppScopedRelativePath,
  resolveExistingAppScopedPath,
  resolveWritableAppScopedPath,
} from "./appScopedFilePaths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe("App-scoped file paths", () => {
  it("rejects traversal, absolute paths, drive paths, NULs, and file descendants", async () => {
    expect(() => normalizeAppScopedRelativePath("../secret")).toThrow("remain inside");
    expect(() => normalizeAppScopedRelativePath("/secret")).toThrow("remain inside");
    expect(() => normalizeAppScopedRelativePath("C:\\secret")).toThrow("remain inside");
    expect(() => normalizeAppScopedRelativePath("a\0b")).toThrow("invalid");
    await expect(
      resolveExistingAppScopedPath({ kind: "file", rootPath: "/tmp/document" }, "child"),
    ).rejects.toThrow("no descendants");
  });

  it("returns normalized entries beneath a selected directory", async () => {
    const rootPath = await temporaryDirectory();
    await FS.promises.mkdir(Path.join(rootPath, "notes"));
    await FS.promises.writeFile(Path.join(rootPath, "notes", "one.txt"), "hello");
    await expect(
      appScopedFileEntry({ kind: "directory", rootPath }, "notes/./one.txt"),
    ).resolves.toMatchObject({
      kind: "file",
      name: "one.txt",
      relativePath: "notes/one.txt",
      size: 5,
    });
  });

  it("rejects read and write through symlinks that escape the selected root", async () => {
    const rootPath = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await FS.promises.writeFile(Path.join(outside, "secret.txt"), "secret");
    await FS.promises.symlink(Path.join(outside, "secret.txt"), Path.join(rootPath, "read-link"));
    await FS.promises.symlink(outside, Path.join(rootPath, "write-link"));
    const root = { kind: "directory" as const, rootPath };
    await expect(resolveExistingAppScopedPath(root, "read-link")).rejects.toThrow("escaped");
    await expect(resolveWritableAppScopedPath(root, "write-link/new.txt")).rejects.toThrow(
      "escaped",
    );
  });

  it("allows a new leaf only when its real parent remains inside the selected root", async () => {
    const rootPath = await temporaryDirectory();
    await FS.promises.mkdir(Path.join(rootPath, "notes"));
    await expect(
      resolveWritableAppScopedPath({ kind: "directory", rootPath }, "notes/new.txt"),
    ).resolves.toBe(Path.join(rootPath, "notes", "new.txt"));
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-files-"));
  temporaryDirectories.push(directory);
  return FS.promises.realpath(directory);
}

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createScopedDirectory,
  listScopedDirectory,
  readScopedBinary,
  removeScopedPath,
  renameScopedPath,
  statScopedPath,
  writeScopedBinary,
  writeScopedText,
} from "./appScopedFileAccess";

describe("scoped App file access", () => {
  it("supports metadata, binary ranges, and mutations beneath one root", async () => {
    const root = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-scoped-files-")));
    try {
      FS.writeFileSync(Path.join(root, "one.txt"), "hello");
      const handle = { id: "root", kind: "directory" as const, name: "root", path: root };
      expect(await statScopedPath(handle, "one.txt")).toMatchObject({ size: 5, kind: "file" });
      expect(
        (await readScopedBinary({ root: handle, relativePath: "one.txt", offset: 1, length: 3 }))
          .bytes,
      ).toEqual(new Uint8Array(Buffer.from("ell")));
      await writeScopedText({ root: handle, relativePath: "created.txt", contents: "new" });
      expect(FS.readFileSync(Path.join(root, "created.txt"), "utf8")).toBe("new");
      await writeScopedBinary({
        root: handle,
        relativePath: "created.bin",
        bytes: new Uint8Array([1, 2, 3]),
      });
      expect(FS.readFileSync(Path.join(root, "created.bin"))).toEqual(Buffer.from([1, 2, 3]));
      await createScopedDirectory(handle, "folder");
      await renameScopedPath(handle, "one.txt", "folder/two.txt");
      expect((await listScopedDirectory(handle, "folder"))[0]).toMatchObject({
        name: "two.txt",
        relativePath: Path.join("folder", "two.txt"),
      });
      await removeScopedPath(handle, "folder/two.txt");
      await removeScopedPath(handle, "folder");
      expect((await listScopedDirectory(handle)).map((entry) => entry.name).sort()).toEqual([
        "created.bin",
        "created.txt",
      ]);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal outside the authorized root", async () => {
    const parent = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-scoped-files-")));
    const root = Path.join(parent, "root");
    FS.mkdirSync(root);
    FS.writeFileSync(Path.join(parent, "secret.txt"), "secret");
    try {
      const handle = { id: "root", kind: "directory" as const, name: "root", path: root };
      await expect(statScopedPath(handle, "../secret.txt")).rejects.toThrow(/escapes/);
      await expect(
        writeScopedText({ root: handle, relativePath: "../created.txt", contents: "no" }),
      ).rejects.toThrow(/escapes/);
    } finally {
      FS.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects writes through symlinks and directory roots without a child path", async () => {
    const parent = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-scoped-files-")));
    const root = Path.join(parent, "root");
    FS.mkdirSync(root);
    const secret = Path.join(parent, "secret.txt");
    FS.writeFileSync(secret, "secret");
    FS.symlinkSync(secret, Path.join(root, "link.txt"));
    try {
      const handle = { id: "root", kind: "directory" as const, name: "root", path: root };
      await expect(
        writeScopedText({ root: handle, relativePath: "link.txt", contents: "no" }),
      ).rejects.toThrow(/Symbolic links/);
      await expect(
        writeScopedBinary({
          root: handle,
          relativePath: "link.txt",
          bytes: new Uint8Array([0]),
        }),
      ).rejects.toThrow(/Symbolic links/);
      await expect(writeScopedText({ root: handle, contents: "no" })).rejects.toThrow(
        /requires a child file path/,
      );
      expect(FS.readFileSync(secret, "utf8")).toBe("secret");
    } finally {
      FS.rmSync(parent, { recursive: true, force: true });
    }
  });
});

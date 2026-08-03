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
      await createScopedDirectory(handle, "folder");
      await renameScopedPath(handle, "one.txt", "folder/two.txt");
      expect((await listScopedDirectory(handle, "folder"))[0]).toMatchObject({
        name: "two.txt",
        relativePath: Path.join("folder", "two.txt"),
      });
      await removeScopedPath(handle, "folder/two.txt");
      await removeScopedPath(handle, "folder");
      expect(await listScopedDirectory(handle)).toEqual([]);
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
    } finally {
      FS.rmSync(parent, { recursive: true, force: true });
    }
  });
});

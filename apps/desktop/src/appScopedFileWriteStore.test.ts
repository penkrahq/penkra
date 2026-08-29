import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppScopedFileWriteStore } from "./appScopedFileWriteStore";

const temporaryDirectories: string[] = [];
const owner = {
  appId: "com.example.canvas",
  spaceId: "space-1",
  threadId: "thread-1",
  tabId: "tab-1",
  rendererId: 7,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.promises.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryFile(name: string): Promise<string> {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-file-write-"));
  temporaryDirectories.push(directory);
  return Path.join(directory, name);
}

describe("AppScopedFileWriteStore", () => {
  it("writes text through the same atomic commit path", async () => {
    const destinationPath = await temporaryFile("notes.txt");
    await FS.promises.writeFile(destinationPath, "old");
    const store = new AppScopedFileWriteStore();

    await store.writeText(owner, {
      handleId: "handle-1",
      destinationPath,
      source: "new text",
    });

    expect(await FS.promises.readFile(destinationPath, "utf8")).toBe("new text");
    expect(await FS.promises.readdir(Path.dirname(destinationPath))).toEqual(["notes.txt"]);
  });

  it("replaces the destination only after an ordered, verified write commits", async () => {
    const destinationPath = await temporaryFile("document.pen");
    await FS.promises.writeFile(destinationPath, "old");
    const source = Buffer.from("a complete new document");
    const store = new AppScopedFileWriteStore();
    const session = await store.begin(owner, {
      handleId: "handle-1",
      destinationPath,
      expectedBytes: source.byteLength,
      expectedSha256: Crypto.createHash("sha256").update(source).digest("hex"),
    });

    await store.write(owner, { writeId: session.writeId, offset: 0, bytes: source.subarray(0, 5) });
    expect(await FS.promises.readFile(destinationPath, "utf8")).toBe("old");
    await store.write(owner, { writeId: session.writeId, offset: 5, bytes: source.subarray(5) });
    await store.commit(owner, session.writeId);

    expect(await FS.promises.readFile(destinationPath)).toEqual(source);
  });

  it("rejects out-of-order chunks and removes an aborted temporary file", async () => {
    const destinationPath = await temporaryFile("document.pen");
    const store = new AppScopedFileWriteStore();
    const session = await store.begin(owner, {
      handleId: "handle-1",
      destinationPath,
      expectedBytes: 3,
    });

    await expect(
      store.write(owner, { writeId: session.writeId, offset: 1, bytes: new Uint8Array([1]) }),
    ).rejects.toThrow("in order");
    await store.abort(owner, session.writeId);

    expect(await FS.promises.readdir(Path.dirname(destinationPath))).toEqual([]);
  });

  it("discards a write whose checksum does not match", async () => {
    const destinationPath = await temporaryFile("document.pen");
    const store = new AppScopedFileWriteStore();
    const session = await store.begin(owner, {
      handleId: "handle-1",
      destinationPath,
      expectedBytes: 3,
      expectedSha256: "0".repeat(64),
    });
    await store.write(owner, {
      writeId: session.writeId,
      offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    });

    await expect(store.commit(owner, session.writeId)).rejects.toThrow("checksum");
    await expect(FS.promises.stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokes only the exact retired generation before asynchronous disposal", async () => {
    const oldPath = await temporaryFile("old-generation.pen");
    const replacementPath = Path.join(Path.dirname(oldPath), "replacement-generation.pen");
    const store = new AppScopedFileWriteStore();
    const oldWrite = await store.begin(owner, {
      handleId: "handle-1",
      destinationPath: oldPath,
      expectedBytes: 1,
    });
    const replacementOwner = { ...owner, rendererId: 8 };
    const replacementWrite = await store.begin(replacementOwner, {
      handleId: "handle-1",
      destinationPath: replacementPath,
      expectedBytes: 1,
    });

    const disposal = store.disposeDetached(store.detachGeneration(owner));
    await expect(
      store.write(owner, {
        writeId: oldWrite.writeId,
        offset: 0,
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      store.write(replacementOwner, {
        writeId: replacementWrite.writeId,
        offset: 0,
        bytes: new Uint8Array([2]),
      }),
    ).resolves.toEqual({ writtenBytes: 1 });
    await disposal;
    await store.abort(replacementOwner, replacementWrite.writeId);
  });
});

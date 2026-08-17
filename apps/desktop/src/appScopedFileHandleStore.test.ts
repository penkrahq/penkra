import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppScopedFileHandleStore } from "./appScopedFileHandleStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe("AppScopedFileHandleStore", () => {
  it("deduplicates canonical resources inside one App and Space", async () => {
    const directory = await temporaryDirectory();
    const path = Path.join(directory, "notes.md");
    await FS.promises.writeFile(path, "hello");
    const store = new AppScopedFileHandleStore();

    const first = await store.grant({ appId: "explorer", spaceId: "one", path });
    const second = await store.grant({ appId: "explorer", spaceId: "one", path });

    expect(second).toEqual(first);
    expect(store.list("explorer", "one")).toEqual([first]);
  });

  it("does not expose a handle to another App or Space", async () => {
    const directory = await temporaryDirectory();
    const store = new AppScopedFileHandleStore();
    const handle = await store.grant({ appId: "explorer", spaceId: "one", path: directory });

    expect(() => store.resolve("other", "one", handle.id)).toThrow("unavailable");
    expect(() => store.resolve("explorer", "two", handle.id)).toThrow("unavailable");
  });

  it("revokes one scope without affecting another Space", async () => {
    const directory = await temporaryDirectory();
    const store = new AppScopedFileHandleStore();
    const first = await store.grant({ appId: "explorer", spaceId: "one", path: directory });
    const second = await store.grant({ appId: "explorer", spaceId: "two", path: directory });

    store.revokeScope("explorer", "one");

    expect(() => store.resolve("explorer", "one", first.id)).toThrow("unavailable");
    expect(store.resolve("explorer", "two", second.id).rootPath).toBe(directory);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-handles-"));
  temporaryDirectories.push(directory);
  return FS.promises.realpath(directory);
}

import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppStorageService } from "./appStorage";

const temporaryRoots: string[] = [];
const owner = { appId: "com.example.app", spaceId: "space-1" };

async function service(): Promise<AppStorageService> {
  const root = await FSP.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-storage-"));
  temporaryRoots.push(root);
  return new AppStorageService(root, 0);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => FSP.rm(root, { recursive: true, force: true })),
  );
});

describe("AppStorageService", () => {
  it("keeps files scoped by App and Space and reports usage", async () => {
    const storage = await service();
    const written = await storage.writeFile(owner, { into: "claims/index.json", content: "hello" });

    expect(written.bytes).toBe(5);
    expect(written.path.startsWith(await FSP.realpath(storage.root(owner)))).toBe(true);
    expect(await FSP.readFile(written.path, "utf8")).toBe("hello");
    expect(await storage.usage(owner)).toEqual({ bytes: 5 });
    expect(await storage.list(owner)).toEqual([
      expect.objectContaining({ path: written.path, bytes: 5 }),
    ]);

    await storage.remove(owner, { path: "claims", recursive: true });
    expect(await storage.list(owner)).toEqual([]);
  });

  it("rejects traversal, oversized writes, and symlink escapes", async () => {
    const storage = await service();
    await expect(storage.writeFile(owner, { into: "../escape", content: "no" })).rejects.toThrow(
      "escapes",
    );
    await expect(
      storage.writeFile(owner, { into: "large", content: "x".repeat(1024 * 1024 + 1) }),
    ).rejects.toThrow("exceeds 1 MiB");

    await storage.writeFile(owner, { into: "safe/file", content: "ok" });
    const link = Path.join(storage.root(owner), "outside");
    await FSP.symlink(OS.tmpdir(), link);
    await expect(storage.list(owner, { path: "outside" })).rejects.toThrow("escapes");
  });

  it("erases only the requested App and Space root", async () => {
    const storage = await service();
    const other = { appId: owner.appId, spaceId: "space-2" };
    await storage.writeFile(owner, { into: "one", content: "1" });
    await storage.writeFile(other, { into: "two", content: "2" });

    await storage.erase(owner);

    expect(await storage.list(owner)).toEqual([]);
    expect(await storage.usage(other)).toEqual({ bytes: 1 });
  });
});

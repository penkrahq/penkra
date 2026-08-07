import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDataVault } from "./appDataVault";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
const crypto = {
  encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
  decrypt: (value: Buffer) => value.toString().slice(10),
};

describe("AppDataVault", () => {
  it("keeps App-wide handles and App/Space-scoped encrypted secrets across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const selected = join(root, "selected.txt");
    await writeFile(selected, "hello");
    await mkdir(join(root, "folder"));
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    const handle = await vault.addHandle("com.example.canvas", {
      kind: "file",
      path: selected,
    });
    await vault.setSecret("com.example.canvas", "personal", "api-token", "secret-value");
    const restarted = await AppDataVault.open({ userDataPath: root, ...crypto });
    expect(restarted.listHandles("com.example.canvas")).toEqual([handle]);
    expect(restarted.resolveHandle("com.example.canvas", handle.id).path).toBe(
      await realpath(selected),
    );
    expect(restarted.getSecret("com.example.canvas", "personal", "api-token")).toBe("secret-value");
    expect(restarted.getSecret("com.example.canvas", "work", "api-token")).toBeNull();
    expect(restarted.getSecret("com.example.other", "personal", "api-token")).toBeNull();
  });

  it("reuses one persistent grant across every tab and Space for the same App", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const selected = join(root, "selected.txt");
    await writeFile(selected, "hello");
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    const [first, second] = await Promise.all([
      vault.addHandle("com.example.explorer", {
        kind: "file",
        path: selected,
      }),
      vault.addHandle("com.example.explorer", {
        kind: "file",
        path: selected,
      }),
    ]);
    const anotherSpace = await vault.addHandle("com.example.explorer", {
      kind: "file",
      path: selected,
    });
    expect(second).toEqual(first);
    expect(anotherSpace).toEqual(first);
    expect(vault.listHandles("com.example.explorer")).toEqual([first]);
  });

  it("revokes App-wide handles while erasing secrets only in the requested Space", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const file = join(root, "selected.txt");
    await writeFile(file, "hello");
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    const personal = await vault.addHandle("com.example.canvas", {
      kind: "file",
      path: file,
    });
    await vault.setSecret("com.example.canvas", "work", "token", "work");
    await vault.revokeHandle("com.example.canvas", personal.id);
    expect(() => vault.resolveHandle("com.example.canvas", personal.id)).toThrow("revoked");
    await vault.erase("com.example.canvas", "personal");
    expect(vault.getSecret("com.example.canvas", "work", "token")).toBe("work");
  });

  it("migrates and deduplicates Space-scoped v1 handles into App-wide grants", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const file = join(root, "selected.txt");
    await writeFile(file, "hello");
    const canonical = await realpath(file);
    await mkdir(join(root, "apps"));
    await writeFile(
      join(root, "apps", "vault-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        handlesByScope: {
          "com.example.explorer\0personal": {
            first: { id: "first", kind: "file", path: canonical, name: "selected.txt" },
          },
          "com.example.explorer\0work": {
            duplicate: { id: "duplicate", kind: "file", path: canonical, name: "selected.txt" },
          },
        },
        secretsByScope: {},
      }),
    );
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    expect(vault.listHandles("com.example.explorer")).toEqual([
      { id: "first", kind: "file", name: "selected.txt" },
    ]);
    expect(vault.resolveHandle("com.example.explorer", "first").path).toBe(canonical);
    expect(vault.resolveHandle("com.example.explorer", "duplicate").path).toBe(canonical);
  });
});

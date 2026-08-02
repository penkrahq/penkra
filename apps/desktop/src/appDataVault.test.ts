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
  it("keeps handles and encrypted secrets scoped by App and Space across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const selected = join(root, "selected.txt");
    await writeFile(selected, "hello");
    await mkdir(join(root, "folder"));
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    const handle = await vault.addHandle("com.example.canvas", "personal", {
      kind: "file",
      path: selected,
    });
    await vault.setSecret("com.example.canvas", "personal", "api-token", "secret-value");
    const restarted = await AppDataVault.open({ userDataPath: root, ...crypto });
    expect(restarted.listHandles("com.example.canvas", "personal")).toEqual([handle]);
    expect(restarted.resolveHandle("com.example.canvas", "personal", handle.id).path).toBe(
      await realpath(selected),
    );
    expect(restarted.getSecret("com.example.canvas", "personal", "api-token")).toBe("secret-value");
    expect(restarted.getSecret("com.example.canvas", "work", "api-token")).toBeNull();
    expect(restarted.getSecret("com.example.other", "personal", "api-token")).toBeNull();
  });

  it("revokes handles and erases one Space without affecting another", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const file = join(root, "selected.txt");
    await writeFile(file, "hello");
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    const personal = await vault.addHandle("com.example.canvas", "personal", {
      kind: "file",
      path: file,
    });
    await vault.setSecret("com.example.canvas", "work", "token", "work");
    await vault.revokeHandle("com.example.canvas", "personal", personal.id);
    expect(() => vault.resolveHandle("com.example.canvas", "personal", personal.id)).toThrow(
      "revoked",
    );
    await vault.erase("com.example.canvas", "personal");
    expect(vault.getSecret("com.example.canvas", "work", "token")).toBe("work");
  });
});

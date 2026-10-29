import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("erases secrets only in the requested Space", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    await vault.setSecret("com.example.canvas", "personal", "token", "personal");
    await vault.setSecret("com.example.canvas", "work", "token", "work");
    await vault.erase("com.example.canvas", "personal");
    expect(vault.getSecret("com.example.canvas", "personal", "token")).toBeNull();
    expect(vault.getSecret("com.example.canvas", "work", "token")).toBe("work");
  });
});

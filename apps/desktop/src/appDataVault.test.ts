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
  it("keeps App/Space-scoped encrypted secrets across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
    roots.push(root);
    const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
    await vault.setSecret("com.example.canvas", "personal", "api-token", "secret-value");
    const restarted = await AppDataVault.open({ userDataPath: root, ...crypto });
    expect(restarted.getSecret("com.example.canvas", "personal", "api-token")).toBe("secret-value");
    expect(restarted.getSecret("com.example.canvas", "work", "api-token")).toBeNull();
    expect(restarted.getSecret("com.example.other", "personal", "api-token")).toBeNull();
  });

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

  it.each([1, 2] as const)(
    "migrates v%s state by preserving secrets and dropping old handles",
    async (schemaVersion) => {
      const root = await mkdtemp(join(tmpdir(), "penkra-app-vault-"));
      roots.push(root);
      await mkdir(join(root, "apps"));
      await writeFile(
        join(root, "apps", "vault-v1.json"),
        JSON.stringify({
          schemaVersion,
          ...(schemaVersion === 1
            ? { handlesByScope: { legacy: {} } }
            : { handlesByApp: { legacy: {} } }),
          secretsByScope: {
            "com.example.explorer\0personal": {
              token: Buffer.from("encrypted:secret").toString("base64"),
            },
          },
        }),
      );
      const vault = await AppDataVault.open({ userDataPath: root, ...crypto });
      expect(vault.getSecret("com.example.explorer", "personal", "token")).toBe("secret");
      const persisted = JSON.parse(await readFile(join(root, "apps", "vault-v1.json"), "utf8"));
      expect(persisted).toEqual({
        schemaVersion: 3,
        secretsByScope: {
          "com.example.explorer\0personal": {
            token: Buffer.from("encrypted:secret").toString("base64"),
          },
        },
      });
    },
  );
});

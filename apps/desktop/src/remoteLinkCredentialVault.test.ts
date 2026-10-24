import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteLinkCredentialVault } from "./remoteLinkCredentialVault";

const roots: string[] = [];
const key = randomBytes(32);
const encryption = {
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  },
  decrypt(value: Buffer) {
    const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
  },
};
async function fixture() {
  const parent = resolve(import.meta.dirname, "../../../.penkra/scratch");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "remote-link-vault-"));
  roots.push(root);
  const input = {
    userDataPath: root,
    accountServiceUrl: "https://api.example.test",
    ...encryption,
  };
  return { root, input, vault: new RemoteLinkCredentialVault(input) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe("RemoteLinkCredentialVault", () => {
  it("keeps one encrypted identity across concurrent creation and restart, without implying access is enabled", async () => {
    const { vault, root, input } = await fixture();
    expect(await vault.read("a")).toBeNull();
    const [first, second] = await Promise.all([vault.getOrCreate("a"), vault.getOrCreate("a")]);
    expect(first).toEqual(second);
    expect(first.registration).toBeNull();
    expect(await new RemoteLinkCredentialVault(input).read("a")).toEqual(first);
    const paths = await readdir(resolve(root, "remote-link"));
    expect(paths).toHaveLength(1);
    const path = resolve(root, "remote-link", paths[0]!);
    expect((await readFile(path)).includes(Buffer.from(first.identityPrivateKey))).toBe(false);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("isolates accounts and account services, persists rotation, and removes only its own identity", async () => {
    const { vault, input } = await fixture();
    const a = await vault.getOrCreate("a");
    const b = await vault.getOrCreate("b");
    expect(a.identityPrivateKey).not.toBe(b.identityPrivateKey);
    const otherService = new RemoteLinkCredentialVault({
      ...input,
      accountServiceUrl: "https://other.example.test",
    });
    expect(await otherService.read("a")).toBeNull();
    const registration = {
      deviceId: "10000000-0000-4000-8000-000000000001",
      deviceToken: randomBytes(32).toString("base64url"),
    };
    await vault.register("a", a.identityPrivateKey, registration);
    expect((await vault.read("a"))?.registration).toEqual(registration);
    await expect(vault.remove("b", a.identityPrivateKey)).rejects.toThrow("identity changed");
    await vault.remove("a", a.identityPrivateKey);
    await expect(vault.register("a", a.identityPrivateKey, registration)).rejects.toThrow(
      "identity changed",
    );
    expect(await vault.read("b")).toEqual(b);
    expect(await vault.read("a")).toBeNull();
  });
  it("fails closed on corrupt storage rather than silently replacing an identity", async () => {
    const { vault, root } = await fixture();
    await vault.getOrCreate("a");
    const [name] = await readdir(resolve(root, "remote-link"));
    await writeFile(resolve(root, "remote-link", name!), "corrupt");
    await expect(vault.getOrCreate("a")).rejects.toThrow();
    expect(await readFile(resolve(root, "remote-link", name!), "utf8")).toBe("corrupt");
  });
});

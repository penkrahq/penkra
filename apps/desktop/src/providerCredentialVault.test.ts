import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { ProviderCredentialVault } from "./providerCredentialVault";

const roots: string[] = [];
const crypto = {
  encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
  decrypt: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProviderCredentialVault", () => {
  it("persists only encrypted secrets and consumes a lease exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-provider-vault-"));
    roots.push(root);
    const vault = await ProviderCredentialVault.open({ userDataPath: root, ...crypto });
    const reference = await vault.store("sentinel-provider-secret");
    const raw = await readFile(join(root, "providers/vault-v1.json"), "utf8");
    expect(raw).not.toContain("sentinel-provider-secret");

    const lease = vault.issueLease(reference);
    expect(vault.consumeLease(lease)).toBe("sentinel-provider-secret");
    expect(() => vault.consumeLease(lease)).toThrow("unavailable or expired");
  });

  it("rejects duplicate live secrets without storing a reversible fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-provider-vault-"));
    roots.push(root);
    const vault = await ProviderCredentialVault.open({ userDataPath: root, ...crypto });
    await vault.store("same-secret");
    await expect(vault.store("same-secret")).rejects.toThrow("already configured");
    const raw = await readFile(join(root, "providers/vault-v1.json"), "utf8");
    expect(raw).not.toContain("same-secret");
  });

  it("makes a caller-owned reference idempotent without allowing identity reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-provider-vault-"));
    roots.push(root);
    const vault = await ProviderCredentialVault.open({ userDataPath: root, ...crypto });
    const reference = "provider-secret:11111111-1111-4111-8111-111111111111";
    expect(await vault.store("stable-secret", undefined, reference)).toBe(reference);
    expect(await vault.store("stable-secret", undefined, reference)).toBe(reference);
    await expect(vault.store("different-secret", undefined, reference)).rejects.toThrow(
      "already assigned",
    );
  });

  it("claims an exact credential identity without retaining a usable secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-provider-vault-"));
    roots.push(root);
    const vault = await ProviderCredentialVault.open({ userDataPath: root, ...crypto });
    const reference = "provider-secret:22222222-2222-4222-8222-222222222222";
    expect(await vault.claim("managed-secret", reference)).toBe(reference);
    expect(vault.has(reference)).toBe(true);
    expect(() => vault.issueLease(reference)).toThrow("unavailable");
    await expect(vault.store("managed-secret")).rejects.toThrow("already configured");
    const raw = await readFile(join(root, "providers/vault-v1.json"), "utf8");
    expect(raw).not.toContain("managed-secret");
    await vault.remove(reference);
    await expect(vault.store("managed-secret")).resolves.toMatch(/^provider-secret:/);
  });

  it("expires leases and revokes outstanding leases when a secret is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "penkra-provider-vault-"));
    roots.push(root);
    let now = 1_000;
    const vault = await ProviderCredentialVault.open({
      userDataPath: root,
      ...crypto,
      now: () => now,
    });
    const first = await vault.store("first");
    const expired = vault.issueLease(first, 10);
    now += 11;
    expect(() => vault.consumeLease(expired)).toThrow("unavailable or expired");
    const active = vault.issueLease(first);
    await vault.remove(first);
    expect(() => vault.consumeLease(active)).toThrow("unavailable or expired");
    expect(vault.has(first)).toBe(false);
  });
});

// FILE: verify-desktop-registry-trust-anchors.ts
// Purpose: Proves the built Electron main bundle pins the configured registry public keys.
// Layer: Release verification script

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function configuredTrustKeys(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) throw new Error("The production Desktop build requires registry trust anchors.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error("PENKRA_REGISTRY_TRUSTED_KEYS must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PENKRA_REGISTRY_TRUSTED_KEYS must contain at least one key.");
  }
  for (const candidate of parsed) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Reflect.get(candidate, "kty") !== "OKP" ||
      Reflect.get(candidate, "crv") !== "Ed25519" ||
      Reflect.get(candidate, "alg") !== "EdDSA" ||
      Reflect.get(candidate, "use") !== "sig" ||
      typeof Reflect.get(candidate, "x") !== "string" ||
      Reflect.get(candidate, "x") === "" ||
      typeof Reflect.get(candidate, "kid") !== "string" ||
      Reflect.get(candidate, "kid") === ""
    ) {
      throw new Error("PENKRA_REGISTRY_TRUSTED_KEYS contains an invalid key.");
    }
  }
  return configured;
}

export function verifyEmbeddedRegistryTrustAnchors(input: {
  readonly bundleSource: string;
  readonly trustedKeysJson: string | undefined;
}): void {
  const configured = configuredTrustKeys(input.trustedKeysJson);
  const embeddedLiteral = JSON.stringify(configured);
  if (!input.bundleSource.includes(embeddedLiteral)) {
    throw new Error(
      "The built Desktop bundle does not contain the configured registry trust anchors.",
    );
  }
}

function main(): void {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const bundlePath = resolve(repoRoot, "apps/desktop/dist-electron/main.js");
  verifyEmbeddedRegistryTrustAnchors({
    bundleSource: readFileSync(bundlePath, "utf8"),
    trustedKeysJson: process.env.PENKRA_REGISTRY_TRUSTED_KEYS,
  });
  console.log("Desktop registry trust anchors are embedded in the built bundle.");
}

if (import.meta.main) main();

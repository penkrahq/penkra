import { describe, expect, it } from "vitest";

import { verifyEmbeddedRegistryTrustAnchors } from "./verify-desktop-registry-trust-anchors.ts";

const TRUSTED_KEYS = JSON.stringify([
  {
    kty: "OKP",
    crv: "Ed25519",
    x: "registry-public-key",
    kid: "registry-key-2026-08",
    alg: "EdDSA",
    use: "sig",
  },
]);

describe("verifyEmbeddedRegistryTrustAnchors", () => {
  it("accepts the exact configured keys embedded by the desktop compiler", () => {
    expect(() =>
      verifyEmbeddedRegistryTrustAnchors({
        bundleSource: `trustedRegistryKeys: parseRegistryTrustKeys(process.env.PENKRA_REGISTRY_TRUSTED_KEYS ?? ${JSON.stringify(TRUSTED_KEYS)})`,
        trustedKeysJson: TRUSTED_KEYS,
      }),
    ).not.toThrow();
  });

  it("rejects a bundle built with an empty fallback", () => {
    expect(() =>
      verifyEmbeddedRegistryTrustAnchors({
        bundleSource:
          'trustedRegistryKeys: parseRegistryTrustKeys(process.env.PENKRA_REGISTRY_TRUSTED_KEYS ?? "")',
        trustedKeysJson: TRUSTED_KEYS,
      }),
    ).toThrow("does not contain the configured registry trust anchors");
  });

  it("rejects missing release configuration", () => {
    expect(() =>
      verifyEmbeddedRegistryTrustAnchors({ bundleSource: "", trustedKeysJson: undefined }),
    ).toThrow("requires registry trust anchors");
  });
});

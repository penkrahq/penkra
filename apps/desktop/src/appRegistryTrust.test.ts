import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parseRegistryTrustKeys,
  verifyRegistryReleaseAttestation,
  type RegistryReleaseExpectation,
  type RegistryTrustKey,
} from "./appRegistryTrust";

const expected: RegistryReleaseExpectation = {
  appId: "app-id",
  identifier: "com.example.canvas",
  slug: "canvas",
  versionId: "version-id",
  version: "1.0.0",
  compatibilityRange: ">=0.8.0",
  packageDigest: "a".repeat(64),
  publishedAt: "2026-08-01T00:00:00.000Z",
  publisherSlug: "example",
  permissions: [{ permission: "network-fetch", required: true, rationale: "Sync" }],
};

describe("registry release trust", () => {
  it("parses an explicit desktop trust-anchor set and rejects empty configuration", () => {
    const fixture = signedFixture();
    expect(parseRegistryTrustKeys(JSON.stringify([fixture.trustKey]))).toEqual([fixture.trustKey]);
    expect(() => parseRegistryTrustKeys("[]")).toThrow("at least one key");
  });
  it("verifies the selected release against a pinned Ed25519 trust anchor", () => {
    const fixture = signedFixture();

    expect(verifyRegistryReleaseAttestation({
      compactJws: fixture.jws,
      trustedKeys: [fixture.trustKey],
      expected,
    })).toMatchObject({
      ...expected,
      keyId: fixture.trustKey.kid,
      publisherSignatureDigest: "e".repeat(64),
    });
  });

  it("rejects tampering, unknown keys, and release-selection mismatches", () => {
    const fixture = signedFixture();
    const [header, payload] = fixture.jws.split(".");

    expect(() => verifyRegistryReleaseAttestation({
      compactJws: `${header}.${payload}.AAAA`,
      trustedKeys: [fixture.trustKey],
      expected,
    })).toThrow("signature is invalid");
    expect(() => verifyRegistryReleaseAttestation({
      compactJws: fixture.jws,
      trustedKeys: [],
      expected,
    })).toThrow("untrusted key");
    expect(() => verifyRegistryReleaseAttestation({
      compactJws: fixture.jws,
      trustedKeys: [fixture.trustKey],
      expected: { ...expected, version: "2.0.0" },
    })).toThrow("does not match");
  });
});

function signedFixture(): { jws: string; trustKey: RegistryTrustKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const kid = createHash("sha256").update(publicDer).digest("hex").slice(0, 16);
  const protectedValue = encode({ alg: "EdDSA", kid, typ: "penkra-release+jws" });
  const payloadValue = encode({
    schemaVersion: 1,
    kind: "penkra-app-release",
    registry: "penkra.com",
    app: { id: expected.appId, identifier: expected.identifier, slug: expected.slug },
    publisher: {
      id: "publisher-id",
      slug: "example",
      signerIdentity: "developer@example.com",
      signerIssuer: "https://accounts.google.com",
    },
    version: {
      id: expected.versionId,
      version: expected.version,
      compatibilityRange: expected.compatibilityRange,
      packageDigest: expected.packageDigest,
      manifestDigest: "b".repeat(64),
      readmeDigest: "c".repeat(64),
      instructionsDigest: "d".repeat(64),
    },
    evidence: {
      publisherSignatureDigest: "e".repeat(64),
      validationReportDigest: "f".repeat(64),
    },
    permissions: expected.permissions,
    publishedAt: expected.publishedAt,
  });
  const signature = sign(null, Buffer.from(`${protectedValue}.${payloadValue}`), privateKey).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jws: `${protectedValue}.${payloadValue}.${signature}`,
    trustKey: { kty: "OKP", crv: "Ed25519", x: jwk.x!, kid, alg: "EdDSA", use: "sig" },
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

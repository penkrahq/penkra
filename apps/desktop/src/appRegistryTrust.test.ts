import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertRegistryReleaseAllowed,
  parseRegistryTrustKeys,
  verifyRegistryPolicyAttestation,
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

    expect(
      verifyRegistryReleaseAttestation({
        compactJws: fixture.jws,
        trustedKeys: [fixture.trustKey],
        expected,
      }),
    ).toMatchObject({ ...expected, keyId: fixture.trustKey.kid });
  });

  it("rejects tampering, unknown keys, and release-selection mismatches", () => {
    const fixture = signedFixture();
    const [header, payload] = fixture.jws.split(".");

    expect(() =>
      verifyRegistryReleaseAttestation({
        compactJws: `${header}.${payload}.AAAA`,
        trustedKeys: [fixture.trustKey],
        expected,
      }),
    ).toThrow("signature is invalid");
    expect(() =>
      verifyRegistryReleaseAttestation({
        compactJws: fixture.jws,
        trustedKeys: [],
        expected,
      }),
    ).toThrow("untrusted key");
    expect(() =>
      verifyRegistryReleaseAttestation({
        compactJws: fixture.jws,
        trustedKeys: [fixture.trustKey],
        expected: { ...expected, version: "2.0.0" },
      }),
    ).toThrow("does not match");
  });
});

describe("registry revocation policy trust", () => {
  it("verifies a fresh signed policy and exposes exact revocation targets", () => {
    const now = new Date("2026-08-02T00:00:00.000Z");
    const fixture = signedPolicyFixture({
      generatedAt: now.toISOString(),
      expiresAt: "2026-08-02T06:00:00.000Z",
    });
    expect(
      verifyRegistryPolicyAttestation({
        compactJws: fixture.jws,
        trustedKeys: [fixture.trustKey],
        now,
      }),
    ).toMatchObject({
      keyId: fixture.trustKey.kid,
      revocations: [
        {
          target: { kind: "version", id: "00000000-0000-4000-8000-000000000702" },
          code: "malware",
        },
      ],
    });
  });

  it("rejects expired and overlong policy validity windows", () => {
    const now = new Date("2026-08-02T08:00:00.000Z");
    const expired = signedPolicyFixture({
      generatedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-08-02T06:00:00.000Z",
    });
    expect(() =>
      verifyRegistryPolicyAttestation({
        compactJws: expired.jws,
        trustedKeys: [expired.trustKey],
        now,
      }),
    ).toThrow("expired");
    const overlong = signedPolicyFixture({
      generatedAt: "2026-08-02T00:00:00.000Z",
      expiresAt: "2026-09-04T00:00:00.000Z",
    });
    expect(() =>
      verifyRegistryPolicyAttestation({
        compactJws: overlong.jws,
        trustedKeys: [overlong.trustKey],
        now: new Date("2026-08-02T01:00:00.000Z"),
      }),
    ).toThrow("validity period");
  });

  it("blocks exact publisher, App, or version identities", () => {
    expect(() =>
      assertRegistryReleaseAllowed(
        {
          registry: "penkra.com",
          generatedAt: "2026-08-02T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
          keyId: "key",
          revocations: [
            {
              id: "00000000-0000-4000-8000-000000000701",
              target: { kind: "app", id: "00000000-0000-4000-8000-000000000702" },
              code: "security",
              reason: "Blocked release",
              effectiveAt: "2026-08-02T00:00:00.000Z",
              expiresAt: null,
            },
          ],
        },
        {
          appId: "00000000-0000-4000-8000-000000000702",
          versionId: "00000000-0000-4000-8000-000000000703",
          publisherId: "00000000-0000-4000-8000-000000000704",
        },
      ),
    ).toThrow("Blocked release");
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
    publisher: { id: "publisher-id", slug: "example" },
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
      validationReportDigest: "f".repeat(64),
    },
    permissions: expected.permissions,
    publishedAt: expected.publishedAt,
  });
  const signature = sign(
    null,
    Buffer.from(`${protectedValue}.${payloadValue}`),
    privateKey,
  ).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jws: `${protectedValue}.${payloadValue}.${signature}`,
    trustKey: { kty: "OKP", crv: "Ed25519", x: jwk.x!, kid, alg: "EdDSA", use: "sig" },
  };
}

function signedPolicyFixture(dates: { generatedAt: string; expiresAt: string }) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const kid = createHash("sha256").update(publicDer).digest("hex").slice(0, 16);
  const protectedValue = encode({ alg: "EdDSA", kid, typ: "penkra-policy+jws" });
  const payloadValue = encode({
    schemaVersion: 1,
    kind: "penkra-app-policy",
    registry: "penkra.com",
    ...dates,
    revocations: [
      {
        id: "00000000-0000-4000-8000-000000000701",
        target: { kind: "version", id: "00000000-0000-4000-8000-000000000702" },
        code: "malware",
        reason: "Known malicious release",
        effectiveAt: dates.generatedAt,
        expiresAt: null,
      },
    ],
  });
  const signature = sign(
    null,
    Buffer.from(`${protectedValue}.${payloadValue}`),
    privateKey,
  ).toString("base64url");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    jws: `${protectedValue}.${payloadValue}.${signature}`,
    trustKey: {
      kty: "OKP",
      crv: "Ed25519",
      x: jwk.x!,
      kid,
      alg: "EdDSA",
      use: "sig",
    } satisfies RegistryTrustKey,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

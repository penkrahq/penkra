// FILE: appRegistryTrust.ts
// Purpose: Verifies registry release attestations against desktop trust anchors.
// Layer: Trusted Electron main process

import { createPublicKey, verify } from "node:crypto";

export type RegistryTrustKey = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg?: "EdDSA";
  use?: "sig";
};

export type RegistryReleaseExpectation = {
  appId: string;
  identifier: string;
  slug: string;
  versionId: string;
  version: string;
  compatibilityRange: string;
  packageDigest: string;
  publishedAt: string;
  publisherSlug: string;
  permissions: ReadonlyArray<{ permission: string; required: boolean; rationale: string }>;
};

export type VerifiedRegistryRelease = RegistryReleaseExpectation & {
  registry: "penkra.com";
  publisher: {
    id: string;
    slug: string;
    signerIdentity: string;
    signerIssuer: string;
  };
  manifestDigest: string;
  readmeDigest: string;
  instructionsDigest: string;
  publisherSignatureDigest: string;
  validationReportDigest: string;
  keyId: string;
};

const SHA256 = /^[a-f0-9]{64}$/;

export function parseRegistryTrustKeys(value: string | undefined): RegistryTrustKey[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PENKRA_REGISTRY_TRUSTED_KEYS must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PENKRA_REGISTRY_TRUSTED_KEYS must contain at least one key.");
  }
  return parsed.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("PENKRA_REGISTRY_TRUSTED_KEYS contains an invalid key.");
    }
    const key = candidate as Record<string, unknown>;
    if (
      key.kty !== "OKP" || key.crv !== "Ed25519" || key.alg !== "EdDSA" || key.use !== "sig" ||
      typeof key.x !== "string" || !key.x || typeof key.kid !== "string" || !key.kid
    ) {
      throw new Error("PENKRA_REGISTRY_TRUSTED_KEYS contains an invalid key.");
    }
    return { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", x: key.x, kid: key.kid };
  });
}

export function verifyRegistryReleaseAttestation(input: {
  compactJws: string;
  trustedKeys: ReadonlyArray<RegistryTrustKey>;
  expected: RegistryReleaseExpectation;
}): VerifiedRegistryRelease {
  if (Buffer.byteLength(input.compactJws, "utf8") > 512 * 1024) {
    throw new Error("Registry release attestation exceeds the allowed size.");
  }
  const parts = input.compactJws.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("Registry release attestation is not a compact JWS.");
  }
  const [protectedValue, payloadValue, signatureValue] = parts as [string, string, string];
  const header = parseObject(protectedValue, "protected header");
  if (header.alg !== "EdDSA" || header.typ !== "penkra-release+jws" || typeof header.kid !== "string") {
    throw new Error("Registry release attestation has an unsupported protected header.");
  }
  const trustedKey = input.trustedKeys.find((candidate) => candidate.kid === header.kid);
  if (!trustedKey) throw new Error("Registry release attestation uses an untrusted key.");
  if (
    trustedKey.kty !== "OKP" ||
    trustedKey.crv !== "Ed25519" ||
    !trustedKey.x ||
    (trustedKey.alg !== undefined && trustedKey.alg !== "EdDSA") ||
    (trustedKey.use !== undefined && trustedKey.use !== "sig")
  ) {
    throw new Error("Registry trust anchor is invalid.");
  }
  const valid = verify(
    null,
    Buffer.from(`${protectedValue}.${payloadValue}`),
    createPublicKey({
      key: { kty: trustedKey.kty, crv: trustedKey.crv, x: trustedKey.x },
      format: "jwk",
    }),
    Buffer.from(signatureValue, "base64url"),
  );
  if (!valid) throw new Error("Registry release attestation signature is invalid.");
  const payload = parseObject(payloadValue, "payload");
  const app = objectField(payload, "app");
  const publisher = objectField(payload, "publisher");
  const version = objectField(payload, "version");
  const evidence = objectField(payload, "evidence");
  const permissions = permissionsField(payload, "permissions");
  if (payload.schemaVersion !== 1 || payload.kind !== "penkra-app-release" || payload.registry !== "penkra.com") {
    throw new Error("Registry release attestation has an unsupported identity.");
  }
  const actual = {
    appId: stringField(app, "id"),
    identifier: stringField(app, "identifier"),
    slug: stringField(app, "slug"),
    versionId: stringField(version, "id"),
    version: stringField(version, "version"),
    compatibilityRange: stringField(version, "compatibilityRange"),
    packageDigest: digestField(version, "packageDigest"),
    publishedAt: stringField(payload, "publishedAt"),
    publisherSlug: stringField(publisher, "slug"),
    permissions,
  };
  if (JSON.stringify(actual) !== JSON.stringify(input.expected)) {
    throw new Error("Registry release attestation does not match the selected App version.");
  }
  return {
    ...actual,
    registry: "penkra.com",
    publisher: {
      id: stringField(publisher, "id"),
      slug: actual.publisherSlug,
      signerIdentity: stringField(publisher, "signerIdentity"),
      signerIssuer: stringField(publisher, "signerIssuer"),
    },
    manifestDigest: digestField(version, "manifestDigest"),
    readmeDigest: digestField(version, "readmeDigest"),
    instructionsDigest: digestField(version, "instructionsDigest"),
    publisherSignatureDigest: digestField(evidence, "publisherSignatureDigest"),
    validationReportDigest: digestField(evidence, "validationReportDigest"),
    keyId: trustedKey.kid,
  };
}

function parseObject(encoded: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Registry release attestation ${label} is invalid.`);
  }
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new Error("Registry release attestation payload is invalid.");
  }
  return field as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error("Registry release attestation payload is invalid.");
  return field;
}

function digestField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!SHA256.test(field)) throw new Error("Registry release attestation digest is invalid.");
  return field;
}

function permissionsField(
  value: Record<string, unknown>,
  key: string,
): Array<{ permission: string; required: boolean; rationale: string }> {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error("Registry release attestation permissions are invalid.");
  return field.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("Registry release attestation permissions are invalid.");
    }
    const permission = candidate as Record<string, unknown>;
    if (typeof permission.required !== "boolean") {
      throw new Error("Registry release attestation permissions are invalid.");
    }
    return {
      permission: stringField(permission, "permission"),
      required: permission.required,
      rationale: stringField(permission, "rationale"),
    };
  });
}

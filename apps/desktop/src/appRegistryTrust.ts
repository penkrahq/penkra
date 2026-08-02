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

export type RegistryRevocation = {
  id: string;
  target: { kind: "publisher" | "app" | "version"; id: string };
  code: string;
  reason: string;
  effectiveAt: string;
  expiresAt: string | null;
};

export type VerifiedRegistryPolicy = {
  registry: "penkra.com";
  generatedAt: string;
  expiresAt: string;
  revocations: ReadonlyArray<RegistryRevocation>;
  keyId: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      key.kty !== "OKP" ||
      key.crv !== "Ed25519" ||
      key.alg !== "EdDSA" ||
      key.use !== "sig" ||
      typeof key.x !== "string" ||
      !key.x ||
      typeof key.kid !== "string" ||
      !key.kid
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
  const verified = verifyCompactJws(input.compactJws, input.trustedKeys, "penkra-release+jws");
  const payload = verified.payload;
  const trustedKey = verified.key;
  if (Buffer.byteLength(input.compactJws, "utf8") > 512 * 1024)
    throw new Error("Registry release attestation exceeds the allowed size.");
  const app = objectField(payload, "app");
  const publisher = objectField(payload, "publisher");
  const version = objectField(payload, "version");
  const evidence = objectField(payload, "evidence");
  const permissions = permissionsField(payload, "permissions");
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "penkra-app-release" ||
    payload.registry !== "penkra.com"
  ) {
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

export function verifyRegistryPolicyAttestation(input: {
  compactJws: string;
  trustedKeys: ReadonlyArray<RegistryTrustKey>;
  now?: Date;
}): VerifiedRegistryPolicy {
  if (Buffer.byteLength(input.compactJws, "utf8") > 2 * 1024 * 1024) {
    throw new Error("Registry policy exceeds the allowed size.");
  }
  const { payload, key } = verifyCompactJws(
    input.compactJws,
    input.trustedKeys,
    "penkra-policy+jws",
  );
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "penkra-app-policy" ||
    payload.registry !== "penkra.com"
  ) {
    throw new Error("Registry policy has an unsupported identity.");
  }
  const generatedAt = dateField(payload, "generatedAt");
  const expiresAt = dateField(payload, "expiresAt");
  const now = input.now ?? new Date();
  if (Date.parse(generatedAt) > now.getTime() + 5 * 60_000)
    throw new Error("Registry policy is from the future.");
  if (Date.parse(expiresAt) <= now.getTime()) throw new Error("Registry policy has expired.");
  if (Date.parse(expiresAt) - Date.parse(generatedAt) > 31 * 24 * 60 * 60_000) {
    throw new Error("Registry policy validity period is too long.");
  }
  if (!Array.isArray(payload.revocations) || payload.revocations.length > 10_000) {
    throw new Error("Registry policy revocations are invalid.");
  }
  const revocations = payload.revocations.map((candidate): RegistryRevocation => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("Registry policy revocations are invalid.");
    }
    const revocation = candidate as Record<string, unknown>;
    const target = objectField(revocation, "target");
    const kind = stringField(target, "kind");
    if (kind !== "publisher" && kind !== "app" && kind !== "version") {
      throw new Error("Registry policy target is invalid.");
    }
    const id = stringField(revocation, "id");
    const targetId = stringField(target, "id");
    if (!UUID.test(id) || !UUID.test(targetId))
      throw new Error("Registry policy identity is invalid.");
    const effectiveAt = dateField(revocation, "effectiveAt");
    const rawExpiresAt = revocation.expiresAt;
    const revocationExpiresAt = rawExpiresAt === null ? null : dateField(revocation, "expiresAt");
    return {
      id,
      target: { kind, id: targetId },
      code: boundedStringField(revocation, "code", 128),
      reason: boundedStringField(revocation, "reason", 2_000),
      effectiveAt,
      expiresAt: revocationExpiresAt,
    };
  });
  return { registry: "penkra.com", generatedAt, expiresAt, revocations, keyId: key.kid };
}

export function assertRegistryReleaseAllowed(
  policy: VerifiedRegistryPolicy,
  release: { appId: string; versionId: string; publisherId: string },
): void {
  const match = policy.revocations.find(
    (revocation) =>
      (revocation.target.kind === "publisher" && revocation.target.id === release.publisherId) ||
      (revocation.target.kind === "app" && revocation.target.id === release.appId) ||
      (revocation.target.kind === "version" && revocation.target.id === release.versionId),
  );
  if (match)
    throw new Error(`This App release is blocked by Penkra (${match.code}): ${match.reason}`);
}

function verifyCompactJws(
  compactJws: string,
  trustedKeys: ReadonlyArray<RegistryTrustKey>,
  type: "penkra-release+jws" | "penkra-policy+jws",
): { payload: Record<string, unknown>; key: RegistryTrustKey } {
  const parts = compactJws.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("Registry release attestation is not a compact JWS.");
  }
  const [protectedValue, payloadValue, signatureValue] = parts as [string, string, string];
  const header = parseObject(protectedValue, "protected header");
  if (header.alg !== "EdDSA" || header.typ !== type || typeof header.kid !== "string") {
    throw new Error("Registry attestation has an unsupported protected header.");
  }
  const trustedKey = trustedKeys.find((candidate) => candidate.kid === header.kid);
  if (!trustedKey) throw new Error("Registry attestation uses an untrusted key.");
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
  if (!valid) throw new Error("Registry attestation signature is invalid.");
  const payload = parseObject(payloadValue, "payload");
  return { payload, key: trustedKey };
}

function parseObject(encoded: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")),
    );
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
  if (typeof field !== "string" || !field)
    throw new Error("Registry release attestation payload is invalid.");
  return field;
}

function boundedStringField(
  value: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const field = stringField(value, key);
  if (field.length > maximumLength) throw new Error("Registry attestation payload is invalid.");
  return field;
}

function dateField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!Number.isFinite(Date.parse(field))) throw new Error("Registry attestation date is invalid.");
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
  if (!Array.isArray(field))
    throw new Error("Registry release attestation permissions are invalid.");
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

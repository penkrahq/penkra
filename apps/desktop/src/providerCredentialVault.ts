// FILE: providerCredentialVault.ts
// Purpose: Owns encrypted provider secrets and one-use, short-lived secret leases in desktop main.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

const SCHEMA_VERSION = 1 as const;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const DEFAULT_LEASE_TTL_MS = 30_000;
const REFERENCE_PREFIX = "provider-secret:";

interface ProviderSecretRecord {
  readonly encrypted: string | null;
  readonly fingerprint: string;
  readonly createdAt: string;
}

interface ProviderCredentialVaultState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly encryptedFingerprintKey: string;
  readonly records: Record<string, ProviderSecretRecord>;
}

interface ProviderSecretLease {
  readonly reference: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: number;
}

export class ProviderCredentialVault {
  readonly #path: string;
  readonly #encrypt: (value: string) => Buffer;
  readonly #decrypt: (value: Buffer) => string;
  readonly #now: () => number;
  #state: ProviderCredentialVaultState;
  #queue = Promise.resolve();
  #leases = new Map<string, ProviderSecretLease>();

  private constructor(
    path: string,
    state: ProviderCredentialVaultState,
    input: {
      encrypt(value: string): Buffer;
      decrypt(value: Buffer): string;
      now?: () => number;
    },
  ) {
    this.#path = path;
    this.#state = state;
    this.#encrypt = input.encrypt;
    this.#decrypt = input.decrypt;
    this.#now = input.now ?? Date.now;
  }

  static async open(input: {
    userDataPath: string;
    encrypt(value: string): Buffer;
    decrypt(value: Buffer): string;
    now?: () => number;
  }): Promise<ProviderCredentialVault> {
    const path = Path.join(input.userDataPath, "providers", "vault-v1.json");
    const state = await readState(path, input.encrypt);
    return new ProviderCredentialVault(path, state, input);
  }

  async store(
    secret: string,
    createdAt = new Date(this.#now()).toISOString(),
    requestedReference?: string,
  ): Promise<string> {
    validateSecret(secret);
    const operation = this.#queue.then(async () => {
      const fingerprint = this.#fingerprint(secret);
      const reference = requestedReference
        ? requireReference(requestedReference)
        : `${REFERENCE_PREFIX}${randomUUID()}`;
      const existingAtReference = this.#state.records[reference];
      if (existingAtReference) {
        if (existingAtReference.fingerprint === fingerprint) return reference;
        throw new Error("Provider credential reference is already assigned.");
      }
      if (Object.values(this.#state.records).some((record) => record.fingerprint === fingerprint)) {
        throw new Error("This provider credential is already configured.");
      }
      const next: ProviderCredentialVaultState = {
        ...this.#state,
        records: {
          ...this.#state.records,
          [reference]: {
            encrypted: this.#encrypt(secret).toString("base64"),
            fingerprint,
            createdAt,
          },
        },
      };
      await writeState(this.#path, next);
      this.#state = next;
      return reference;
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async claim(
    secret: string,
    requestedReference: string,
    createdAt = new Date(this.#now()).toISOString(),
  ): Promise<string> {
    validateSecret(secret);
    const operation = this.#queue.then(async () => {
      const fingerprint = this.#fingerprint(secret);
      const reference = requireReference(requestedReference);
      const existingAtReference = this.#state.records[reference];
      if (existingAtReference) {
        if (existingAtReference.fingerprint === fingerprint) return reference;
        throw new Error("Provider credential reference is already assigned.");
      }
      if (Object.values(this.#state.records).some((record) => record.fingerprint === fingerprint)) {
        throw new Error("This provider credential is already configured.");
      }
      const next: ProviderCredentialVaultState = {
        ...this.#state,
        records: {
          ...this.#state.records,
          [reference]: { encrypted: null, fingerprint, createdAt },
        },
      };
      await writeState(this.#path, next);
      this.#state = next;
      return reference;
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  has(reference: string): boolean {
    return this.#state.records[requireReference(reference)] !== undefined;
  }

  fingerprint(secret: string): string {
    validateSecret(secret);
    return this.#fingerprint(secret);
  }

  issueLease(reference: string, ttlMs = DEFAULT_LEASE_TTL_MS): string {
    const normalized = requireReference(reference);
    if (!this.#state.records[normalized]?.encrypted)
      throw new Error("Provider credential is unavailable.");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_LEASE_TTL_MS) {
      throw new Error("Provider credential lease duration is invalid.");
    }
    this.#pruneExpiredLeases();
    const token = randomBytes(32).toString("base64url");
    const leaseId = randomUUID();
    this.#leases.set(leaseId, {
      reference: normalized,
      tokenHash: hashToken(token),
      expiresAt: this.#now() + ttlMs,
    });
    return `${leaseId}.${token}`;
  }

  consumeLease(capability: string): string {
    const separator = capability.indexOf(".");
    if (separator <= 0) throw new Error("Provider credential lease is invalid.");
    const leaseId = capability.slice(0, separator);
    const token = capability.slice(separator + 1);
    const lease = this.#leases.get(leaseId);
    // Consumption is terminal even when validation fails, preventing retries
    // from becoming an oracle for a still-live credential capability.
    this.#leases.delete(leaseId);
    if (
      !lease ||
      lease.expiresAt < this.#now() ||
      token.length === 0 ||
      !safeEqual(lease.tokenHash, hashToken(token))
    ) {
      throw new Error("Provider credential lease is unavailable or expired.");
    }
    const record = this.#state.records[lease.reference];
    if (!record?.encrypted) throw new Error("Provider credential is unavailable.");
    return this.#decrypt(Buffer.from(record.encrypted, "base64"));
  }

  async remove(reference: string): Promise<void> {
    const normalized = requireReference(reference);
    const operation = this.#queue.then(async () => {
      const records = { ...this.#state.records };
      delete records[normalized];
      const next = { ...this.#state, records };
      await writeState(this.#path, next);
      this.#state = next;
      for (const [leaseId, lease] of this.#leases) {
        if (lease.reference === normalized) this.#leases.delete(leaseId);
      }
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #fingerprint(secret: string): string {
    const key = Buffer.from(
      this.#decrypt(Buffer.from(this.#state.encryptedFingerprintKey, "base64")),
      "base64",
    );
    return createHmac("sha256", key).update(secret).digest("hex");
  }

  #pruneExpiredLeases(): void {
    const now = this.#now();
    for (const [leaseId, lease] of this.#leases) {
      if (lease.expiresAt < now) this.#leases.delete(leaseId);
    }
  }
}

function validateSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Provider credential is empty.");
  }
  if (Buffer.byteLength(secret) > MAX_SECRET_BYTES) {
    throw new Error("Provider credential exceeds 64 KiB.");
  }
}

function requireReference(reference: string): string {
  if (
    !reference.startsWith(REFERENCE_PREFIX) ||
    reference.length > 128 ||
    reference.includes("\0")
  ) {
    throw new Error("Provider credential reference is invalid.");
  }
  return reference;
}

function hashToken(token: string): Buffer {
  return createHmac("sha256", "penkra-provider-credential-lease").update(token).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readState(
  path: string,
  encrypt: (value: string) => Buffer,
): Promise<ProviderCredentialVaultState> {
  const bytes = await FS.readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!bytes) {
    return {
      schemaVersion: SCHEMA_VERSION,
      encryptedFingerprintKey: encrypt(randomBytes(32).toString("base64")).toString("base64"),
      records: {},
    };
  }
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("Provider vault exceeds its size limit.");
  const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ProviderCredentialVaultState>;
  if (
    parsed.schemaVersion !== SCHEMA_VERSION ||
    typeof parsed.encryptedFingerprintKey !== "string" ||
    typeof parsed.records !== "object" ||
    parsed.records === null
  ) {
    throw new Error("Provider vault state is invalid.");
  }
  return parsed as ProviderCredentialVaultState;
}

async function writeState(path: string, state: ProviderCredentialVaultState): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (bytes.byteLength > MAX_STATE_BYTES) throw new Error("Provider vault exceeds its size limit.");
  await FS.mkdir(Path.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await FS.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await FS.rename(temporary, path);
}

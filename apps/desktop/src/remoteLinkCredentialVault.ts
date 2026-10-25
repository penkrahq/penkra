// Desktop main owns encryption; RemoteLink receives secrets only over the backend-only pipe.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES } from "@penkra/shared/desktopCredentialLimits";
import { fsyncDirectory } from "@penkra/shared/fsyncDirectory";

export interface RemoteLinkCredentials {
  readonly identityPrivateKey: string;
  readonly registration: { readonly deviceId: string; readonly deviceToken: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function decodeRemoteLinkRegistration(
  value: unknown,
): NonNullable<RemoteLinkCredentials["registration"]> {
  if (!value || typeof value !== "object") throw new Error("Invalid RemoteLink registration.");
  const item = value as Record<string, unknown>;
  if (
    typeof item.deviceId !== "string" ||
    !UUID.test(item.deviceId) ||
    typeof item.deviceToken !== "string" ||
    !TOKEN.test(item.deviceToken) ||
    Buffer.from(item.deviceToken, "base64url").toString("base64url") !== item.deviceToken
  )
    throw new Error("Invalid RemoteLink registration.");
  return { deviceId: item.deviceId, deviceToken: item.deviceToken };
}

function decode(value: unknown): RemoteLinkCredentials {
  if (!value || typeof value !== "object") throw new Error("Invalid RemoteLink credentials.");
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.identityPrivateKey !== "string" ||
    Buffer.from(row.identityPrivateKey, "base64").length !== 32 ||
    Buffer.from(row.identityPrivateKey, "base64").toString("base64") !== row.identityPrivateKey
  )
    throw new Error("Invalid RemoteLink identity.");
  const registration = row.registration;
  if (registration !== null) {
    return {
      identityPrivateKey: row.identityPrivateKey,
      registration: decodeRemoteLinkRegistration(registration),
    };
  }
  return { identityPrivateKey: row.identityPrivateKey, registration: null };
}

export class RemoteLinkCredentialVault {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly input: {
      userDataPath: string;
      accountServiceUrl: string;
      encrypt(value: string): Buffer;
      decrypt(value: Buffer): string;
    },
  ) {}

  #path(accountId: string) {
    if (!accountId) throw new Error("A signed-in account is required.");
    const scope = createHash("sha256")
      .update(JSON.stringify([this.input.accountServiceUrl, accountId]))
      .digest("hex");
    return join(this.input.userDataPath, "remote-link", `${scope}.secret`);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #read(path: string): Promise<RemoteLinkCredentials | null> {
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!bytes) return null;
    if (bytes.length > DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES)
      throw new Error("RemoteLink credentials exceed their size limit.");
    try {
      return decode(JSON.parse(this.input.decrypt(bytes)));
    } catch {
      throw new Error("RemoteLink credentials could not be decrypted or are invalid.");
    }
  }

  async #write(path: string, credentials: RemoteLinkCredentials) {
    const bytes = this.input.encrypt(JSON.stringify({ version: 1, ...credentials }));
    if (bytes.length > DESKTOP_CREDENTIAL_MAX_RESPONSE_BYTES)
      throw new Error("RemoteLink credentials exceed their size limit.");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    fsyncDirectory(this.input.userDataPath);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      fsyncDirectory(dirname(path));
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  read(accountId: string) {
    return this.#serialize(() => this.#read(this.#path(accountId)));
  }

  getOrCreate(accountId: string): Promise<RemoteLinkCredentials> {
    return this.#serialize(async () => {
      const path = this.#path(accountId);
      const existing = await this.#read(path);
      if (existing) return existing;
      const credentials = {
        identityPrivateKey: randomBytes(32).toString("base64"),
        registration: null,
      };
      await this.#write(path, credentials);
      return credentials;
    });
  }

  register(
    accountId: string,
    identityPrivateKey: string,
    registration: NonNullable<RemoteLinkCredentials["registration"]>,
  ) {
    return this.#serialize(async () => {
      const path = this.#path(accountId);
      const current = await this.#read(path);
      if (!current || current.identityPrivateKey !== identityPrivateKey)
        throw new Error("RemoteLink identity changed during registration.");
      const next = decode({ version: 1, identityPrivateKey, registration });
      await this.#write(path, next);
    });
  }

  remove(accountId: string, identityPrivateKey: string) {
    return this.#serialize(async () => {
      const path = this.#path(accountId);
      const current = await this.#read(path);
      if (!current) return;
      if (current.identityPrivateKey !== identityPrivateKey)
        throw new Error("RemoteLink identity changed during removal.");
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      fsyncDirectory(dirname(path));
    });
  }
}

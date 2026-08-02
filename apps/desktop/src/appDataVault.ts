// FILE: appDataVault.ts
// Purpose: Persists App/Space-scoped encrypted secrets and user-selected file handles.
// Layer: Trusted desktop App runtime

import { randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

const SCHEMA_VERSION = 1 as const;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const SECRET_NAME = /^[a-z][a-z0-9-]{0,63}$/;

type FileHandleRecord = { id: string; kind: "file" | "directory"; path: string; name: string };
type VaultState = {
  schemaVersion: typeof SCHEMA_VERSION;
  handlesByScope: Record<string, Record<string, FileHandleRecord>>;
  secretsByScope: Record<string, Record<string, string>>;
};

export class AppDataVault {
  readonly #path: string;
  readonly #encrypt: (value: string) => Buffer;
  readonly #decrypt: (value: Buffer) => string;
  #state: VaultState;
  #queue = Promise.resolve();

  private constructor(
    path: string,
    state: VaultState,
    crypto: { encrypt(value: string): Buffer; decrypt(value: Buffer): string },
  ) {
    this.#path = path;
    this.#state = state;
    this.#encrypt = crypto.encrypt;
    this.#decrypt = crypto.decrypt;
  }

  static async open(input: {
    userDataPath: string;
    encrypt(value: string): Buffer;
    decrypt(value: Buffer): string;
  }): Promise<AppDataVault> {
    const path = Path.join(input.userDataPath, "apps", "vault-v1.json");
    const state = await readState(path);
    return new AppDataVault(path, state, input);
  }

  listHandles(appId: string, spaceId: string): ReadonlyArray<Omit<FileHandleRecord, "path">> {
    return Object.values(this.#state.handlesByScope[scope(appId, spaceId)] ?? {}).map(
      ({ path: _path, ...handle }) => handle,
    );
  }

  async addHandle(
    appId: string,
    spaceId: string,
    input: { kind: "file" | "directory"; path: string },
  ): Promise<Omit<FileHandleRecord, "path">> {
    const absolute = await FS.realpath(Path.resolve(input.path));
    const stat = await FS.stat(absolute);
    if (
      (input.kind === "file" && !stat.isFile()) ||
      (input.kind === "directory" && !stat.isDirectory())
    ) {
      throw new Error(`The selected ${input.kind} is unavailable.`);
    }
    const handle: FileHandleRecord = {
      id: randomUUID(),
      kind: input.kind,
      path: absolute,
      name: Path.basename(absolute),
    };
    await this.#mutate((state) => {
      const key = scope(appId, spaceId);
      state.handlesByScope[key] = { ...(state.handlesByScope[key] ?? {}), [handle.id]: handle };
    });
    const { path: _path, ...publicHandle } = handle;
    return publicHandle;
  }

  resolveHandle(
    appId: string,
    spaceId: string,
    handleId: string,
    expected?: "file" | "directory",
  ): FileHandleRecord {
    const handle = this.#state.handlesByScope[scope(appId, spaceId)]?.[handleId];
    if (!handle || (expected && handle.kind !== expected))
      throw new Error("The App file handle is unavailable or revoked.");
    return handle;
  }

  async revokeHandle(appId: string, spaceId: string, handleId: string): Promise<void> {
    await this.#mutate((state) => {
      const key = scope(appId, spaceId);
      const handles = { ...(state.handlesByScope[key] ?? {}) };
      delete handles[handleId];
      state.handlesByScope[key] = handles;
    });
  }

  async setSecret(appId: string, spaceId: string, name: string, value: string): Promise<void> {
    validateSecret(name, value);
    const encrypted = this.#encrypt(value).toString("base64");
    await this.#mutate((state) => {
      const key = scope(appId, spaceId);
      state.secretsByScope[key] = { ...(state.secretsByScope[key] ?? {}), [name]: encrypted };
    });
  }

  getSecret(appId: string, spaceId: string, name: string): string | null {
    validateSecretName(name);
    const encrypted = this.#state.secretsByScope[scope(appId, spaceId)]?.[name];
    return encrypted ? this.#decrypt(Buffer.from(encrypted, "base64")) : null;
  }

  async deleteSecret(appId: string, spaceId: string, name: string): Promise<void> {
    validateSecretName(name);
    await this.#mutate((state) => {
      const key = scope(appId, spaceId);
      const secrets = { ...(state.secretsByScope[key] ?? {}) };
      delete secrets[name];
      state.secretsByScope[key] = secrets;
    });
  }

  async erase(appId: string, spaceId?: string): Promise<void> {
    await this.#mutate((state) => {
      for (const key of new Set([
        ...Object.keys(state.handlesByScope),
        ...Object.keys(state.secretsByScope),
      ])) {
        if (
          key.startsWith(`${appId}\0`) &&
          (spaceId === undefined || key === scope(appId, spaceId))
        ) {
          delete state.handlesByScope[key];
          delete state.secretsByScope[key];
        }
      }
    });
  }

  #mutate(change: (state: VaultState) => void): Promise<void> {
    const operation = this.#queue.then(async () => {
      const next = structuredClone(this.#state);
      change(next);
      await writeState(this.#path, next);
      this.#state = next;
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function scope(appId: string, spaceId: string): string {
  if (!appId || !spaceId || appId.includes("\0") || spaceId.includes("\0"))
    throw new Error("App vault scope is invalid.");
  return `${appId}\0${spaceId}`;
}

function validateSecretName(name: string): void {
  if (!SECRET_NAME.test(name))
    throw new Error("Secret names must be lowercase hyphenated identifiers up to 64 characters.");
}

function validateSecret(name: string, value: string): void {
  validateSecretName(name);
  if (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024)
    throw new Error("Secrets may contain at most 64 KiB of text.");
}

async function readState(path: string): Promise<VaultState> {
  const bytes = await FS.readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!bytes) return { schemaVersion: SCHEMA_VERSION, handlesByScope: {}, secretsByScope: {} };
  if (bytes.byteLength > MAX_STATE_BYTES)
    throw new Error("App vault state exceeds its size limit.");
  const value = JSON.parse(bytes.toString("utf8")) as Partial<VaultState>;
  if (value.schemaVersion !== SCHEMA_VERSION || !value.handlesByScope || !value.secretsByScope)
    throw new Error("App vault state is invalid.");
  return value as VaultState;
}

async function writeState(path: string, state: VaultState): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (bytes.byteLength > MAX_STATE_BYTES)
    throw new Error("App vault state exceeds its size limit.");
  await FS.mkdir(Path.dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await FS.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await FS.rename(temporary, path);
}

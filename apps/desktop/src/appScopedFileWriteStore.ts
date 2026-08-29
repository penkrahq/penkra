// FILE: appScopedFileWriteStore.ts
// Purpose: Owns bounded, atomic chunked writes for App-scoped file capabilities.
// Layer: Trusted desktop App capability boundary

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

export const APP_FILE_WRITE_CHUNK_BYTES = 1024 * 1024;
export const APP_FILE_WRITE_MAX_BYTES = 64 * 1024 * 1024;

export interface AppScopedFileWriteOwner {
  appId: string;
  spaceId: string;
  threadId: string;
  tabId: string;
  rendererId: number;
}

export interface AppScopedFileWriteSession extends AppScopedFileWriteOwner {
  id: string;
  handleId: string;
  destinationPath: string;
  temporaryPath: string;
  expectedBytes: number;
  expectedSha256?: string;
  writtenBytes: number;
  hash: Crypto.Hash;
  file: FS.promises.FileHandle;
}

const detachedWritesBrand: unique symbol = Symbol("DetachedAppScopedFileWrites");

export interface DetachedAppScopedFileWrites {
  readonly [detachedWritesBrand]: true;
  readonly sessions: readonly AppScopedFileWriteSession[];
}

export class AppScopedFileWriteStore {
  readonly #sessions = new Map<string, AppScopedFileWriteSession>();

  async begin(
    owner: AppScopedFileWriteOwner,
    input: {
      handleId: string;
      destinationPath: string;
      expectedBytes: number;
      expectedSha256?: string;
    },
  ): Promise<{ writeId: string; chunkBytes: number }> {
    if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 0) {
      throw new Error("Expected file size must be a non-negative integer.");
    }
    if (input.expectedBytes > APP_FILE_WRITE_MAX_BYTES) {
      throw new Error("File exceeds the 64 MB chunked write limit.");
    }
    if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.expectedSha256)) {
      throw new Error("Expected SHA-256 must be a hexadecimal digest.");
    }

    const id = Crypto.randomUUID();
    const temporaryPath = Path.join(
      Path.dirname(input.destinationPath),
      `.${Path.basename(input.destinationPath)}.penkra-${id}.tmp`,
    );
    const file = await FS.promises.open(temporaryPath, "wx", 0o600);
    this.#sessions.set(id, {
      ...owner,
      id,
      handleId: input.handleId,
      destinationPath: input.destinationPath,
      temporaryPath,
      expectedBytes: input.expectedBytes,
      ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256.toLowerCase() } : {}),
      writtenBytes: 0,
      hash: Crypto.createHash("sha256"),
      file,
    });
    return { writeId: id, chunkBytes: APP_FILE_WRITE_CHUNK_BYTES };
  }

  async writeText(
    owner: AppScopedFileWriteOwner,
    input: { handleId: string; destinationPath: string; source: string },
  ): Promise<void> {
    const bytes = Buffer.from(input.source, "utf8");
    const session = await this.begin(owner, {
      handleId: input.handleId,
      destinationPath: input.destinationPath,
      expectedBytes: bytes.byteLength,
    });
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += APP_FILE_WRITE_CHUNK_BYTES) {
        await this.write(owner, {
          writeId: session.writeId,
          offset,
          bytes: bytes.subarray(offset, offset + APP_FILE_WRITE_CHUNK_BYTES),
        });
      }
      await this.commit(owner, session.writeId);
    } catch (error) {
      await this.abort(owner, session.writeId).catch(() => undefined);
      throw error;
    }
  }

  async write(
    owner: AppScopedFileWriteOwner,
    input: { writeId: unknown; offset: unknown; bytes: unknown },
  ): Promise<{ writtenBytes: number }> {
    const session = this.#resolve(owner, input.writeId);
    if (!Number.isSafeInteger(input.offset) || input.offset !== session.writtenBytes) {
      throw new Error("File chunks must be written once, in order.");
    }
    if (!(input.bytes instanceof Uint8Array)) throw new Error("File chunk must be binary data.");
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > APP_FILE_WRITE_CHUNK_BYTES) {
      throw new Error("File chunk must contain between 1 byte and 1 MB.");
    }
    if (session.writtenBytes + input.bytes.byteLength > session.expectedBytes) {
      throw new Error("File chunks exceed the expected file size.");
    }

    const buffer = Buffer.from(input.bytes);
    let chunkOffset = 0;
    while (chunkOffset < buffer.byteLength) {
      const { bytesWritten } = await session.file.write(
        buffer,
        chunkOffset,
        buffer.byteLength - chunkOffset,
        session.writtenBytes + chunkOffset,
      );
      if (bytesWritten === 0) throw new Error("File chunk could not be written.");
      chunkOffset += bytesWritten;
    }
    session.hash.update(buffer);
    session.writtenBytes += buffer.byteLength;
    return { writtenBytes: session.writtenBytes };
  }

  async commit(owner: AppScopedFileWriteOwner, writeId: unknown): Promise<void> {
    const session = this.#resolve(owner, writeId);
    if (session.writtenBytes !== session.expectedBytes) {
      throw new Error("File write is incomplete.");
    }
    const actualSha256 = session.hash.digest("hex");
    if (session.expectedSha256 && actualSha256 !== session.expectedSha256) {
      await this.#discard(session);
      throw new Error("File checksum did not match the expected contents.");
    }

    this.#sessions.delete(session.id);
    try {
      await session.file.sync();
      await session.file.close();
      await FS.promises.rename(session.temporaryPath, session.destinationPath);
    } catch (error) {
      await FS.promises.rm(session.temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async abort(owner: AppScopedFileWriteOwner, writeId: unknown): Promise<void> {
    await this.#discard(this.#resolve(owner, writeId));
  }

  detachGeneration(owner: AppScopedFileWriteOwner): DetachedAppScopedFileWrites {
    return this.#detach(
      (session) =>
        session.appId === owner.appId &&
        session.spaceId === owner.spaceId &&
        session.threadId === owner.threadId &&
        session.tabId === owner.tabId &&
        session.rendererId === owner.rendererId,
    );
  }

  detachTab(
    owner: Pick<AppScopedFileWriteOwner, "appId" | "spaceId" | "threadId" | "tabId">,
  ): DetachedAppScopedFileWrites {
    return this.#detach(
      (session) =>
        session.appId === owner.appId &&
        session.spaceId === owner.spaceId &&
        session.threadId === owner.threadId &&
        session.tabId === owner.tabId,
    );
  }

  detachScope(appId: string, spaceId: string): DetachedAppScopedFileWrites {
    return this.#detach((session) => session.appId === appId && session.spaceId === spaceId);
  }

  detachHandle(appId: string, spaceId: string, handleId: string): DetachedAppScopedFileWrites {
    return this.#detach(
      (session) =>
        session.appId === appId && session.spaceId === spaceId && session.handleId === handleId,
    );
  }

  async disposeDetached(detached: DetachedAppScopedFileWrites): Promise<void> {
    const failures = (
      await Promise.allSettled(detached.sessions.map((session) => this.#disposeSession(session)))
    ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length > 0) throw new AggregateError(failures, "App file-write disposal failed.");
  }

  async abortAll(): Promise<void> {
    await this.disposeDetached(this.#detach(() => true));
  }

  #resolve(owner: AppScopedFileWriteOwner, writeId: unknown): AppScopedFileWriteSession {
    if (typeof writeId !== "string") throw new Error("File write ID must be a string.");
    const session = this.#sessions.get(writeId);
    if (
      !session ||
      session.appId !== owner.appId ||
      session.spaceId !== owner.spaceId ||
      session.threadId !== owner.threadId ||
      session.tabId !== owner.tabId ||
      session.rendererId !== owner.rendererId
    ) {
      throw new Error("The file write session is unavailable.");
    }
    return session;
  }

  async #discard(session: AppScopedFileWriteSession): Promise<void> {
    this.#sessions.delete(session.id);
    await this.#disposeSession(session);
  }

  async #disposeSession(session: AppScopedFileWriteSession): Promise<void> {
    await session.file.close().catch(() => undefined);
    await FS.promises.rm(session.temporaryPath, { force: true }).catch(() => undefined);
  }

  #detach(predicate: (session: AppScopedFileWriteSession) => boolean): DetachedAppScopedFileWrites {
    const sessions: AppScopedFileWriteSession[] = [];
    for (const [id, session] of this.#sessions) {
      if (!predicate(session)) continue;
      sessions.push(session);
      this.#sessions.delete(id);
    }
    return { [detachedWritesBrand]: true, sessions };
  }
}

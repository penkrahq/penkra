// FILE: appScopedFileHandleStore.ts
// Purpose: Owns session-scoped App file capabilities created by pickers and trusted host handoffs.
// Layer: Trusted desktop App capability boundary

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

export interface AppScopedFileHandleRecord {
  id: string;
  appId: string;
  spaceId: string;
  kind: "file" | "directory";
  name: string;
  rootPath: string;
}

export type AppScopedFileHandle = Pick<AppScopedFileHandleRecord, "id" | "kind" | "name">;

export class AppScopedFileHandleStore {
  readonly #handles = new Map<string, AppScopedFileHandleRecord>();

  list(appId: string, spaceId: string): AppScopedFileHandle[] {
    return [...this.#handles.values()]
      .filter((handle) => handle.appId === appId && handle.spaceId === spaceId)
      .map(publicHandle);
  }

  async grant(input: {
    appId: string;
    spaceId: string;
    path: string;
    kind?: "file" | "directory";
  }): Promise<AppScopedFileHandle> {
    const rootPath = await FS.promises.realpath(input.path);
    const stats = await FS.promises.stat(rootPath);
    const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : null;
    if (!kind) throw new Error("Only regular files and directories can become App handles.");
    if (input.kind && input.kind !== kind) throw new Error("The selected resource kind changed.");

    const existing = [...this.#handles.values()].find(
      (handle) =>
        handle.appId === input.appId &&
        handle.spaceId === input.spaceId &&
        handle.kind === kind &&
        handle.rootPath === rootPath,
    );
    if (existing) return publicHandle(existing);

    const handle: AppScopedFileHandleRecord = {
      id: Crypto.randomUUID(),
      appId: input.appId,
      spaceId: input.spaceId,
      kind,
      name: Path.basename(rootPath),
      rootPath,
    };
    this.#handles.set(handle.id, handle);
    return publicHandle(handle);
  }

  async grantWritableFile(input: {
    appId: string;
    spaceId: string;
    path: string;
  }): Promise<AppScopedFileHandle> {
    if (!Path.isAbsolute(input.path) || input.path.includes("\0")) {
      throw new Error("The save destination must be an absolute file path.");
    }
    const parent = await FS.promises.realpath(Path.dirname(input.path));
    const stats = await FS.promises.stat(parent);
    if (!stats.isDirectory()) throw new Error("The save destination parent is not a directory.");
    const rootPath = Path.join(parent, Path.basename(input.path));
    try {
      const existingPath = await FS.promises.realpath(rootPath);
      const existing = await FS.promises.stat(existingPath);
      if (!existing.isFile()) throw new Error("The save destination must be a regular file.");
      if (existingPath !== rootPath) throw new Error("The save destination cannot be a symlink.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const duplicate = [...this.#handles.values()].find(
      (handle) =>
        handle.appId === input.appId &&
        handle.spaceId === input.spaceId &&
        handle.kind === "file" &&
        handle.rootPath === rootPath,
    );
    if (duplicate) return publicHandle(duplicate);
    const handle: AppScopedFileHandleRecord = {
      id: Crypto.randomUUID(),
      appId: input.appId,
      spaceId: input.spaceId,
      kind: "file",
      name: Path.basename(rootPath),
      rootPath,
    };
    this.#handles.set(handle.id, handle);
    return publicHandle(handle);
  }

  resolve(appId: string, spaceId: string, handleId: unknown): AppScopedFileHandleRecord {
    if (typeof handleId !== "string") throw new Error("File handle ID must be a string.");
    const handle = this.#handles.get(handleId);
    if (!handle || handle.appId !== appId || handle.spaceId !== spaceId) {
      throw Object.assign(new Error("The scoped file handle is unavailable."), {
        code: "HANDLE_REVOKED",
      });
    }
    return handle;
  }

  revoke(appId: string, spaceId: string, handleId: unknown): void {
    const handle = this.resolve(appId, spaceId, handleId);
    this.#handles.delete(handle.id);
  }

  revokeScope(appId: string, spaceId?: string): void {
    for (const [handleId, handle] of this.#handles) {
      if (handle.appId !== appId || (spaceId !== undefined && handle.spaceId !== spaceId)) continue;
      this.#handles.delete(handleId);
    }
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function publicHandle(handle: AppScopedFileHandleRecord): AppScopedFileHandle {
  return { id: handle.id, kind: handle.kind, name: handle.name };
}

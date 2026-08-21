// FILE: appBlobUrlRegistry.ts
// Purpose: Owns unguessable, tab-lifetime URLs for App-authorized local files.
// Layer: Trusted desktop App capability boundary

import * as Crypto from "node:crypto";

export const APP_BLOB_URL_PREFIX = "/.penkra/blob/";

export interface AppBlobUrlOwner {
  appId: string;
  spaceId: string;
  tabId: string;
  rendererId: number;
  origin: string;
}

export interface AppBlobUrlRecord extends AppBlobUrlOwner {
  token: string;
  path: string;
  handleId?: string;
}

export class AppBlobUrlRegistry {
  readonly #records = new Map<string, AppBlobUrlRecord>();

  open(owner: AppBlobUrlOwner, path: string, input: { handleId?: string } = {}): string {
    const token = Crypto.randomBytes(32).toString("base64url");
    this.#records.set(token, { ...owner, token, path, ...input });
    return `${owner.origin}${APP_BLOB_URL_PREFIX}${token}`;
  }

  resolve(origin: string, token: string): AppBlobUrlRecord {
    const record = this.#records.get(token);
    if (!record || record.origin !== origin) throw new Error("The App blob URL is unavailable.");
    return record;
  }

  close(owner: AppBlobUrlOwner, url: unknown): void {
    if (typeof url !== "string") throw new Error("App blob URL must be a string.");
    const token = blobToken(owner.origin, url);
    const record = this.resolve(owner.origin, token);
    if (
      record.appId !== owner.appId ||
      record.spaceId !== owner.spaceId ||
      record.tabId !== owner.tabId ||
      record.rendererId !== owner.rendererId
    ) {
      throw new Error("The App blob URL is unavailable.");
    }
    this.#records.delete(token);
  }

  revokeMatching(predicate: (record: AppBlobUrlRecord) => boolean): void {
    for (const [token, record] of this.#records) {
      if (predicate(record)) this.#records.delete(token);
    }
  }

  clear(): void {
    this.#records.clear();
  }
}

export function blobToken(origin: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("App blob URL is invalid.");
  }
  const expected = new URL(origin);
  if (parsed.protocol !== expected.protocol || parsed.host !== expected.host) {
    throw new Error("App blob URL belongs to another origin.");
  }
  if (!parsed.pathname.startsWith(APP_BLOB_URL_PREFIX) || parsed.search || parsed.hash) {
    throw new Error("App blob URL is invalid.");
  }
  const token = parsed.pathname.slice(APP_BLOB_URL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("App blob URL is invalid.");
  return token;
}

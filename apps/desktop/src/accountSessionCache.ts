import { safeStorage } from "electron";
import type { DesktopAccountUser } from "@penkra/contracts";

export const ACCOUNT_STORAGE_PREFIX = "penkra-account";
const USER_CACHE_KEY = `${ACCOUNT_STORAGE_PREFIX}.local_cache`;
const COOKIE_KEY = `${ACCOUNT_STORAGE_PREFIX}.cookie`;

interface AccountStorage {
  getItem(key: string): unknown;
  setItem(key: string, value: unknown): void;
}

/** The same encrypted keys used by the pinned Better Auth Electron client. */
export class AccountSessionCache {
  constructor(private readonly storage: AccountStorage) {}

  read(): DesktopAccountUser | null {
    const encoded = this.storage.getItem(USER_CACHE_KEY);
    if (encoded === null || encoded === undefined) return null;
    if (typeof encoded !== "string" || !safeStorage.isEncryptionAvailable())
      throw new Error("The stored account session cannot be decrypted.");
    const value: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64")));
    if (value === null) return null;
    if (typeof value !== "object" || Array.isArray(value))
      throw new Error("The stored account session is invalid.");
    const user = (value as { user?: unknown }).user;
    if (user === undefined || user === null) return null;
    if (typeof user !== "object" || Array.isArray(user))
      throw new Error("The stored account user is invalid.");
    const account = user as Record<string, unknown>;
    if (
      typeof account.id !== "string" ||
      !account.id ||
      typeof account.email !== "string" ||
      typeof account.name !== "string"
    )
      throw new Error("The stored account user is invalid.");
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      image: typeof account.image === "string" ? account.image : null,
    };
  }

  write(user: DesktopAccountUser): void {
    this.#write(USER_CACHE_KEY, JSON.stringify({ user }));
  }

  clear(): void {
    this.#write(COOKIE_KEY, "{}");
    this.#write(USER_CACHE_KEY, "{}");
  }

  #write(key: string, value: string): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("Encrypted account storage is unavailable.");
    this.storage.setItem(key, safeStorage.encryptString(value).toString("base64"));
  }
}

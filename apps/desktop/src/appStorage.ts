// FILE: appStorage.ts
// Purpose: Provides host-mediated, App/Space-scoped local storage and streaming transfers.
// Layer: Trusted desktop App capability boundary

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

const WRITE_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024;
const COMPOSER_ATTACHMENT_MAX_BYTES = 256 * 1024 * 1024;

export type AppStorageOwner = { appId: string; spaceId: string };

export class AppStorageService {
  readonly #basePath: string;
  readonly #minimumFreeBytes: number;

  constructor(userDataPath: string, minimumFreeBytes = configuredMinimumFreeBytes()) {
    this.#basePath = Path.join(userDataPath, "apps", "storage-v1");
    this.#minimumFreeBytes = minimumFreeBytes;
  }

  root(owner: AppStorageOwner): string {
    const digest = Crypto.createHash("sha256")
      .update(owner.appId)
      .update("\0")
      .update(owner.spaceId)
      .digest("hex");
    return Path.join(this.#basePath, digest);
  }

  async writeFile(
    owner: AppStorageOwner,
    input: { into: string; content: string; encoding?: "utf-8" | "base64" },
  ): Promise<{ path: string; bytes: number }> {
    if (typeof input.content !== "string") throw new Error("App storage content must be text.");
    const bytes = Buffer.from(input.content, input.encoding === "base64" ? "base64" : "utf8");
    if (bytes.byteLength > WRITE_FILE_MAX_BYTES)
      throw new Error("App storage writeFile content exceeds 1 MiB.");
    await this.#assertFreeSpace(owner, bytes.byteLength);
    const destination = await this.#destination(owner, input.into);
    await atomicWrite(destination, bytes);
    return { path: destination, bytes: bytes.byteLength };
  }

  async remove(
    owner: AppStorageOwner,
    input: { path: string; recursive?: boolean },
  ): Promise<void> {
    const target = await this.#existing(owner, input.path, true);
    if (target === this.root(owner))
      throw new Error("Use App data removal to erase the storage root.");
    const stat = await FSP.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("App storage does not follow symbolic links.");
    if (stat.isDirectory() && input.recursive !== true)
      throw new Error("recursive must be true to remove an App storage directory.");
    await FSP.rm(target, { recursive: input.recursive === true, force: false });
  }

  async list(
    owner: AppStorageOwner,
    input: { path?: string } = {},
  ): Promise<Array<{ path: string; bytes: number; modifiedAt: string }>> {
    const root = await this.#ensureRoot(owner);
    const target = input.path ? await this.#existing(owner, input.path, true) : root;
    const output: Array<{ path: string; bytes: number; modifiedAt: string }> = [];
    await walk(target, root, output);
    return output;
  }

  async usage(owner: AppStorageOwner): Promise<{ bytes: number }> {
    const entries = await this.list(owner);
    return { bytes: entries.reduce((total, entry) => total + entry.bytes, 0) };
  }

  async erase(owner: AppStorageOwner): Promise<void> {
    await FSP.rm(this.root(owner), { recursive: true, force: true });
  }

  async readComposerAttachment(
    owner: AppStorageOwner,
    input: { path: string; name?: string; mimeType?: string },
  ): Promise<{ name: string; mimeType: string; bytes: Uint8Array }> {
    const source = await this.#source(owner, input.path);
    if (source.bytes > COMPOSER_ATTACHMENT_MAX_BYTES) {
      throw new Error("Composer attachments may not exceed 256 MiB.");
    }
    return {
      name: input.name?.trim() || Path.basename(source.path),
      mimeType: input.mimeType?.trim() || "application/octet-stream",
      bytes: new Uint8Array(await FSP.readFile(source.path)),
    };
  }

  async resolveFile(owner: AppStorageOwner, path: string): Promise<string> {
    return (await this.#source(owner, path)).path;
  }

  async resolveDestination(owner: AppStorageOwner, path: string): Promise<string> {
    return this.#destination(owner, path);
  }

  async assertFreeSpace(owner: AppStorageOwner, incomingBytes: number): Promise<void> {
    await this.#assertFreeSpace(owner, incomingBytes);
  }

  async prepareDownload(
    owner: AppStorageOwner,
    input: { directory: string; suggestedName: string },
  ): Promise<string> {
    const safeName = sanitizeFilename(input.suggestedName);
    const parsed = Path.parse(safeName);
    for (let index = 0; index < 10_000; index += 1) {
      const name = index === 0 ? safeName : `${parsed.name}-${index}${parsed.ext}`;
      const candidate = await this.#destination(owner, Path.join(input.directory, name));
      try {
        await FSP.access(candidate);
      } catch {
        return candidate;
      }
    }
    throw new Error("Unable to allocate a collision-free App download path.");
  }

  prepareDownloadSync(
    owner: AppStorageOwner,
    input: { directory: string; suggestedName: string },
  ): string {
    const root = this.root(owner);
    const directory = confinedPath(root, input.directory, false);
    FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const safeName = sanitizeFilename(input.suggestedName);
    const parsed = Path.parse(safeName);
    for (let index = 0; index < 10_000; index += 1) {
      const name = index === 0 ? safeName : `${parsed.name}-${index}${parsed.ext}`;
      const candidate = Path.join(directory, name);
      if (!FS.existsSync(candidate)) return candidate;
    }
    throw new Error("Unable to allocate a collision-free App download path.");
  }

  async #ensureRoot(owner: AppStorageOwner): Promise<string> {
    const root = this.root(owner);
    await FSP.mkdir(root, { recursive: true, mode: 0o700 });
    return FSP.realpath(root);
  }

  async #destination(owner: AppStorageOwner, relativePath: string): Promise<string> {
    const root = await this.#ensureRoot(owner);
    const target = confinedPath(root, relativePath, false);
    await FSP.mkdir(Path.dirname(target), { recursive: true, mode: 0o700 });
    const parent = await FSP.realpath(Path.dirname(target));
    assertInside(root, parent, true);
    let existing: Awaited<ReturnType<typeof FSP.lstat>> | null = null;
    try {
      existing = await FSP.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing?.isSymbolicLink() || existing?.isDirectory())
      throw new Error("App storage destination must be a regular file path.");
    return target;
  }

  async #existing(owner: AppStorageOwner, value: string, allowRoot: boolean): Promise<string> {
    const root = await this.#ensureRoot(owner);
    const candidate = Path.isAbsolute(value)
      ? Path.resolve(value)
      : confinedPath(root, value, allowRoot);
    assertInside(root, candidate, allowRoot);
    const resolved = await FSP.realpath(candidate);
    assertInside(root, resolved, allowRoot);
    return resolved;
  }

  async #source(owner: AppStorageOwner, value: string): Promise<{ path: string; bytes: number }> {
    const path = await this.#existing(owner, value, false);
    const stat = await FSP.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("App storage upload source must be a regular file.");
    return { path, bytes: stat.size };
  }

  async #assertFreeSpace(owner: AppStorageOwner, incomingBytes: number): Promise<void> {
    const root = await this.#ensureRoot(owner);
    const stats = await FSP.statfs(root);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (available - incomingBytes < this.#minimumFreeBytes) {
      throw Object.assign(new Error("App storage write refused because the disk is nearly full."), {
        code: "INSUFFICIENT_DISK_SPACE",
      });
    }
  }
}

function configuredMinimumFreeBytes(): number {
  const value = Number(process.env.PENKRA_APP_STORAGE_MIN_FREE_BYTES ?? DEFAULT_MIN_FREE_BYTES);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MIN_FREE_BYTES;
}

function confinedPath(root: string, value: string, allowRoot: boolean): string {
  if (typeof value !== "string" || Path.isAbsolute(value) || value.includes("\0"))
    throw new Error("App storage path must be relative.");
  const target = Path.resolve(root, value || ".");
  assertInside(root, target, allowRoot);
  return target;
}

function assertInside(root: string, target: string, allowRoot = false): void {
  const relative = Path.relative(root, target);
  if ((!allowRoot && relative === "") || relative.startsWith("..") || Path.isAbsolute(relative))
    throw new Error("App storage path escapes its App and Space scope.");
}

async function atomicWrite(destination: string, bytes: Buffer): Promise<void> {
  const temporary = `${destination}.${Crypto.randomUUID()}.tmp`;
  try {
    await FSP.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await FSP.rename(temporary, destination);
  } catch (error) {
    await FSP.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function walk(
  target: string,
  root: string,
  output: Array<{ path: string; bytes: number; modifiedAt: string }>,
): Promise<void> {
  const stat = await FSP.lstat(target);
  if (stat.isSymbolicLink()) throw new Error("App storage does not follow symbolic links.");
  if (stat.isFile()) {
    output.push({ path: target, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of await FSP.readdir(target)) await walk(Path.join(target, entry), root, output);
}

function sanitizeFilename(value: string): string {
  const normalized = Path.basename(value || "download")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return normalized.slice(0, 180) || "download";
}

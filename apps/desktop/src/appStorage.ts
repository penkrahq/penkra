// FILE: appStorage.ts
// Purpose: Provides host-mediated, App/Space-scoped local storage and streaming transfers.
// Layer: Trusted desktop App capability boundary

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as HTTPS from "node:https";
import * as Path from "node:path";
import { once } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

import {
  parseAppNetworkUrl,
  resolvePublicAppNetworkAddress,
  validateAppNetworkHeaders,
} from "./appNetworkFetch";

const WRITE_FILE_MAX_BYTES = 1024 * 1024;
const RESPONSE_BODY_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
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

  async fetchToFile(
    owner: AppStorageOwner,
    input: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      into: string;
    },
  ): Promise<{ path: string; bytes: number; sha256: string }> {
    const destination = await this.#destination(owner, input.into);
    const temporary = `${destination}.${Crypto.randomUUID()}.tmp`;
    await this.#assertFreeSpace(owner, 0);
    try {
      const result = await this.#download(owner, input, temporary, 0);
      await FSP.rename(temporary, destination);
      return { path: destination, ...result };
    } catch (error) {
      await FSP.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async uploadFromFile(
    owner: AppStorageOwner,
    input: {
      url: string;
      method?: "POST" | "PUT";
      headers?: Record<string, string>;
      from: string;
      field?: string;
    },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const source = await this.#source(owner, input.from);
    return this.#upload(source, input, 0);
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

  async #download(
    owner: AppStorageOwner,
    input: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
    destination: string,
    redirects: number,
  ): Promise<{ bytes: number; sha256: string }> {
    const url = parseAppNetworkUrl(input.url);
    const method = input.method ?? "GET";
    const body = input.body === undefined ? null : Buffer.from(input.body);
    if (method === "GET" && body) throw new Error("GET downloads cannot include a body.");
    if (body && body.byteLength > WRITE_FILE_MAX_BYTES)
      throw new Error("App storage download request body exceeds 1 MiB.");
    const headers = validateAppNetworkHeaders(input.headers ?? {});
    const address = await resolvePublicAppNetworkAddress(url.hostname);
    const response = await sendRequest({ url, address, method, headers, body });
    if (isRedirect(response.statusCode) && response.headers.location) {
      response.resume();
      if (redirects >= MAX_REDIRECTS)
        throw new Error("App storage download exceeded five redirects.");
      const next = new URL(response.headers.location, url);
      const nextMethod =
        response.statusCode === 303 ||
        ((response.statusCode === 301 || response.statusCode === 302) && method === "POST")
          ? "GET"
          : method;
      return this.#download(
        owner,
        nextMethod === "GET"
          ? {
              url: next.toString(),
              method: "GET",
              ...(input.headers === undefined ? {} : { headers: input.headers }),
            }
          : { ...input, url: next.toString(), method: nextMethod },
        destination,
        redirects + 1,
      );
    }
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      const errorBody = await boundedResponseBody(response);
      throw new Error(`App storage download failed with HTTP ${response.statusCode}: ${errorBody}`);
    }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > 0) await this.#assertFreeSpace(owner, declared);
    const file = await FSP.open(destination, "wx", 0o600);
    const hash = Crypto.createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of response) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes % (16 * 1024 * 1024) < buffer.byteLength) await this.#assertFreeSpace(owner, 0);
        hash.update(buffer);
        await file.write(buffer);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    return { bytes, sha256: hash.digest("hex") };
  }

  async #upload(
    source: { path: string; bytes: number },
    input: {
      url: string;
      method?: "POST" | "PUT";
      headers?: Record<string, string>;
      field?: string;
    },
    redirects: number,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const url = parseAppNetworkUrl(input.url);
    const method = input.method ?? "POST";
    const headers = validateAppNetworkHeaders(input.headers ?? {});
    const address = await resolvePublicAppNetworkAddress(url.hostname);
    const boundary = input.field ? `penkra-${Crypto.randomBytes(18).toString("hex")}` : null;
    if (input.field && !/^[A-Za-z0-9_.-]{1,100}$/.test(input.field))
      throw new Error("Multipart field name is invalid.");
    const prefix = boundary
      ? Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${input.field}"; filename="${Path.basename(source.path).replace(/["\r\n]/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        )
      : Buffer.alloc(0);
    const suffix = boundary ? Buffer.from(`\r\n--${boundary}--\r\n`) : Buffer.alloc(0);
    if (boundary) headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
    headers["content-length"] = String(prefix.byteLength + source.bytes + suffix.byteLength);
    const request = HTTPS.request({
      protocol: "https:",
      hostname: address,
      servername: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...headers, host: url.host },
      timeout: 60_000,
    });
    const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error("App storage upload timed out.")));
    });
    try {
      if (prefix.byteLength) request.write(prefix);
      for await (const chunk of FS.createReadStream(source.path)) {
        if (!request.write(chunk)) await once(request, "drain");
      }
      request.end(suffix);
      const response = await responsePromise;
      if (isRedirect(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS)
          throw new Error("App storage upload exceeded five redirects.");
        const redirected = new URL(response.headers.location, url);
        const redirectedHeaders =
          redirected.origin === url.origin
            ? input.headers
            : stripCrossOriginCredentials(input.headers);
        return this.#upload(
          source,
          {
            ...input,
            ...(redirectedHeaders === undefined ? {} : { headers: redirectedHeaders }),
            url: redirected.toString(),
          },
          redirects + 1,
        );
      }
      const body = await boundedResponseBody(response);
      return { status: response.statusCode ?? 0, headers: responseHeaders(response.headers), body };
    } catch (error) {
      request.destroy();
      throw error;
    }
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

function stripCrossOriginCredentials(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sensitive = new Set(["authorization", "cookie", "proxy-authorization"]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase())),
  );
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

function sendRequest(input: {
  url: URL;
  address: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = HTTPS.request(
      {
        protocol: "https:",
        hostname: input.address,
        servername: input.url.hostname,
        port: input.url.port ? Number(input.url.port) : 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: { ...input.headers, host: input.url.host },
        timeout: 60_000,
      },
      resolve,
    );
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("App storage request timed out.")));
    if (input.body) request.write(input.body);
    request.end();
  });
}

async function boundedResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > RESPONSE_BODY_MAX_BYTES) throw new Error("App storage response exceeds 1 MiB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ),
  );
}

function isRedirect(status: number | undefined): boolean {
  return status !== undefined && [301, 302, 303, 307, 308].includes(status);
}

function sanitizeFilename(value: string): string {
  const normalized = Path.basename(value || "download")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return normalized.slice(0, 180) || "download";
}

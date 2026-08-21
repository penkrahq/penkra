// FILE: appTransfer.ts
// Purpose: Streams App-authorized bytes between local files and host-validated HTTPS destinations.
// Layer: Trusted desktop App capability boundary

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as HTTPS from "node:https";
import * as Path from "node:path";
import { once } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import {
  parseAppNetworkUrl,
  resolvePublicAppNetworkAddress,
  validateAppNetworkHeaders,
} from "./appNetworkFetch";

export const APP_TRANSFER_URL_PREFIX = "/.penkra/transfer/";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const TICKET_LIFETIME_MS = 5 * 60_000;

export interface AppTransferOwner {
  appId: string;
  spaceId: string;
  tabId: string;
  rendererId: number;
  origin: string;
}

export interface AppTransferProgressEvent {
  id: string;
  phase: "uploading" | "downloading";
  movedBytes: number;
  totalBytes: number | null;
}

interface PinnedDestination {
  url: URL;
  address: string;
  method: string;
  headers: Record<string, string>;
}

interface AppTransferTicket extends AppTransferOwner, PinnedDestination {
  id: string;
  token: string;
  expiresAt: number;
}

export class AppTransferService {
  readonly #tickets = new Map<string, AppTransferTicket>();
  readonly #active = new Map<string, { owner: AppTransferOwner; controller: AbortController }>();
  readonly #emitProgress: (owner: AppTransferOwner, event: AppTransferProgressEvent) => void;

  constructor(input: {
    emitProgress(owner: AppTransferOwner, event: AppTransferProgressEvent): void;
  }) {
    this.#emitProgress = input.emitProgress;
  }

  async begin(
    owner: AppTransferOwner,
    input: { url: string; method?: "POST" | "PUT" | "PATCH"; headers?: Record<string, string> },
  ): Promise<{ id: string; endpoint: string }> {
    const now = Date.now();
    for (const [token, ticket] of this.#tickets) {
      if (ticket.expiresAt < now) this.#tickets.delete(token);
    }
    const pinned = await pinDestination(input, new Set(["POST", "PUT", "PATCH"]), "POST");
    const token = Crypto.randomBytes(32).toString("base64url");
    const id = Crypto.randomUUID();
    this.#tickets.set(token, {
      ...owner,
      ...pinned,
      id,
      token,
      expiresAt: now + TICKET_LIFETIME_MS,
    });
    return { id, endpoint: `${owner.origin}${APP_TRANSFER_URL_PREFIX}${token}` };
  }

  async handleEndpoint(origin: string, request: Request): Promise<Response> {
    const ticket = this.#consumeTicket(origin, request.url);
    if (request.method.toUpperCase() !== ticket.method) {
      throw new Error(`Transfer endpoint requires ${ticket.method}.`);
    }
    const declared = parseContentLength(request.headers.get("content-length"));
    const response = await this.#runActive(ticket, ticket.id, (signal) =>
      requestStream(ticket, request.body, signal, (movedBytes) =>
        this.#emitProgress(ticket, {
          id: ticket.id,
          phase: "uploading",
          movedBytes,
          totalBytes: declared,
        }),
      ),
    );
    return incomingResponse(response);
  }

  async send(
    owner: AppTransferOwner,
    input: {
      url: string;
      method?: "POST" | "PUT" | "PATCH";
      headers?: Record<string, string>;
      field?: string;
    },
    source: { path: string },
  ): Promise<{ id: string; status: number; headers: Record<string, string>; body: string }> {
    const id = Crypto.randomUUID();
    return this.#runActive(owner, id, async (signal) => {
      const file = await FSP.open(source.path, FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW);
      try {
        const stats = await file.stat();
        if (!stats.isFile()) throw new Error("Transfer source must be a regular file.");
        const result = await this.#sendFile(
          owner,
          id,
          input,
          { path: source.path, bytes: stats.size, file },
          signal,
          0,
        );
        return { id, ...result };
      } finally {
        await file.close().catch(() => undefined);
      }
    });
  }

  async receive(
    owner: AppTransferOwner,
    input: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
    destination: { path: string; assertFreeSpace?(bytes: number): Promise<void> },
  ): Promise<{ id: string; bytes: number; sha256: string }> {
    const id = Crypto.randomUUID();
    return this.#runActive(owner, id, async (signal) => {
      const result = await this.#receiveFile(owner, id, input, destination, signal, 0);
      return { id, ...result };
    });
  }

  revokeMatching(predicate: (owner: AppTransferOwner) => boolean): void {
    for (const [token, ticket] of this.#tickets) {
      if (predicate(ticket)) this.#tickets.delete(token);
    }
    for (const active of this.#active.values()) {
      if (predicate(active.owner)) active.controller.abort();
    }
  }

  clear(): void {
    this.#tickets.clear();
    for (const active of this.#active.values()) active.controller.abort();
    this.#active.clear();
  }

  async #sendFile(
    owner: AppTransferOwner,
    id: string,
    input: {
      url: string;
      method?: "POST" | "PUT" | "PATCH";
      headers?: Record<string, string>;
      field?: string;
    },
    source: { path: string; bytes: number; file: FSP.FileHandle },
    signal: AbortSignal,
    redirects: number,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const pinned = await pinDestination(input, new Set(["POST", "PUT", "PATCH"]), "POST");
    if (input.field !== undefined && !/^[A-Za-z0-9_.-]{1,100}$/u.test(input.field)) {
      throw new Error("Multipart field name is invalid.");
    }
    const boundary = input.field ? `penkra-${Crypto.randomBytes(18).toString("hex")}` : null;
    const prefix = boundary
      ? Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${input.field}"; filename="${Path.basename(source.path).replace(/["\r\n]/gu, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        )
      : Buffer.alloc(0);
    const suffix = boundary ? Buffer.from(`\r\n--${boundary}--\r\n`) : Buffer.alloc(0);
    if (boundary) pinned.headers["content-type"] = `multipart/form-data; boundary=${boundary}`;
    pinned.headers["content-length"] = String(prefix.byteLength + source.bytes + suffix.byteLength);
    const response = await requestFile(
      pinned,
      source.file,
      prefix,
      suffix,
      signal,
      (movedBytes) => {
        this.#emitProgress(owner, {
          id,
          phase: "uploading",
          movedBytes: Math.min(source.bytes, Math.max(0, movedBytes - prefix.byteLength)),
          totalBytes: source.bytes,
        });
      },
    );
    if (isRedirect(response.statusCode) && response.headers.location) {
      response.resume();
      if (redirects >= MAX_REDIRECTS) throw new Error("App transfer exceeded five redirects.");
      return this.#sendFile(
        owner,
        id,
        redirectInput(input, pinned.url, response.headers.location),
        source,
        signal,
        redirects + 1,
      );
    }
    return {
      status: response.statusCode ?? 0,
      headers: responseHeaders(response.headers),
      body: await boundedResponseBody(response),
    };
  }

  async #receiveFile(
    owner: AppTransferOwner,
    id: string,
    input: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
    destination: { path: string; assertFreeSpace?(bytes: number): Promise<void> },
    signal: AbortSignal,
    redirects: number,
  ): Promise<{ bytes: number; sha256: string }> {
    const pinned = await pinDestination(input, new Set(["GET", "POST"]), "GET");
    const body = input.body === undefined ? null : Buffer.from(input.body);
    if (pinned.method === "GET" && body) throw new Error("GET transfers cannot include a body.");
    if (body && body.byteLength > 1024 * 1024) {
      throw new Error("Transfer request body exceeds 1 MiB.");
    }
    if (body) pinned.headers["content-length"] = String(body.byteLength);
    const response = await requestBuffer(pinned, body, signal);
    if (isRedirect(response.statusCode) && response.headers.location) {
      response.resume();
      if (redirects >= MAX_REDIRECTS) throw new Error("App transfer exceeded five redirects.");
      const nextMethod =
        response.statusCode === 303 ||
        ((response.statusCode === 301 || response.statusCode === 302) && pinned.method === "POST")
          ? "GET"
          : pinned.method;
      const redirected = {
        ...redirectInput(input, pinned.url, response.headers.location),
        method: nextMethod as "GET" | "POST",
      };
      if (nextMethod === "GET") delete redirected.body;
      return this.#receiveFile(owner, id, redirected, destination, signal, redirects + 1);
    }
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      throw new Error(
        `App transfer download failed with HTTP ${response.statusCode}: ${await boundedResponseBody(response)}`,
      );
    }
    const totalBytes = parseContentLength(headerValue(response.headers["content-length"]));
    await destination.assertFreeSpace?.(totalBytes ?? 0);
    return atomicReceive(response, destination.path, signal, async (movedBytes) => {
      if (movedBytes % (16 * 1024 * 1024) < 128 * 1024) {
        await destination.assertFreeSpace?.(0);
      }
      this.#emitProgress(owner, {
        id,
        phase: "downloading",
        movedBytes,
        totalBytes,
      });
    });
  }

  async #runActive<Result>(
    owner: AppTransferOwner,
    id: string,
    run: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const controller = new AbortController();
    this.#active.set(id, { owner, controller });
    try {
      return await run(controller.signal);
    } finally {
      this.#active.delete(id);
    }
  }

  #consumeTicket(origin: string, value: string): AppTransferTicket {
    const url = new URL(value);
    const expected = new URL(origin);
    if (url.protocol !== expected.protocol || url.host !== expected.host) {
      throw new Error("Transfer endpoint belongs to another origin.");
    }
    const token = url.pathname.startsWith(APP_TRANSFER_URL_PREFIX)
      ? url.pathname.slice(APP_TRANSFER_URL_PREFIX.length)
      : "";
    const ticket = this.#tickets.get(token);
    this.#tickets.delete(token);
    if (!ticket || ticket.origin !== origin || ticket.expiresAt < Date.now()) {
      throw new Error("The transfer endpoint is unavailable.");
    }
    return ticket;
  }
}

async function pinDestination(
  input: { url: string; method?: string; headers?: Record<string, string> },
  allowedMethods: ReadonlySet<string>,
  defaultMethod: string,
): Promise<PinnedDestination> {
  const url = parseAppNetworkUrl(input.url);
  const method = (input.method ?? defaultMethod).toUpperCase();
  if (!allowedMethods.has(method)) throw new Error(`Transfer method ${method} is not supported.`);
  return {
    url,
    method,
    headers: validateAppNetworkHeaders(input.headers ?? {}),
    address: await resolvePublicAppNetworkAddress(url.hostname),
  };
}

function createRequest(
  pinned: PinnedDestination,
  signal: AbortSignal,
): ReturnType<typeof HTTPS.request> {
  return HTTPS.request({
    protocol: "https:",
    hostname: pinned.address,
    servername: pinned.url.hostname,
    port: pinned.url.port ? Number(pinned.url.port) : 443,
    path: `${pinned.url.pathname}${pinned.url.search}`,
    method: pinned.method,
    headers: { ...pinned.headers, host: pinned.url.host },
    timeout: 60_000,
    signal,
  });
}

async function requestStream(
  pinned: PinnedDestination,
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<IncomingMessage> {
  const request = createRequest(pinned, signal);
  const response = responsePromise(request);
  let moved = 0;
  let reported = false;
  try {
    if (body) {
      for await (const chunk of Readable.fromWeb(body as never)) {
        const buffer = Buffer.from(chunk as Uint8Array);
        moved += buffer.byteLength;
        if (!request.write(buffer)) await once(request, "drain");
        onProgress(moved);
        reported = true;
      }
    }
    if (!reported) onProgress(0);
    request.end();
    return await response;
  } catch (error) {
    request.destroy();
    throw error;
  }
}

async function requestFile(
  pinned: PinnedDestination,
  file: FSP.FileHandle,
  prefix: Buffer,
  suffix: Buffer,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<IncomingMessage> {
  const request = createRequest(pinned, signal);
  const response = responsePromise(request);
  let moved = 0;
  let reported = false;
  try {
    if (prefix.byteLength) {
      request.write(prefix);
      moved += prefix.byteLength;
    }
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
      const buffer = Buffer.from(chunk);
      moved += buffer.byteLength;
      if (!request.write(buffer)) await once(request, "drain");
      onProgress(moved);
      reported = true;
    }
    if (!reported) onProgress(moved);
    request.end(suffix);
    return await response;
  } catch (error) {
    request.destroy();
    throw error;
  }
}

function requestBuffer(
  pinned: PinnedDestination,
  body: Buffer | null,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const request = createRequest(pinned, signal);
  const response = responsePromise(request);
  if (body) request.write(body);
  request.end();
  return response;
}

function responsePromise(request: ReturnType<typeof HTTPS.request>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("App transfer timed out.")));
  });
}

async function atomicReceive(
  response: IncomingMessage,
  destination: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  const id = Crypto.randomUUID();
  const temporary = Path.join(
    Path.dirname(destination),
    `.${Path.basename(destination)}.penkra-${id}.tmp`,
  );
  const file = await FSP.open(temporary, "wx", 0o600);
  const hash = Crypto.createHash("sha256");
  let bytes = 0;
  const abort = () => response.destroy(new Error("App transfer was cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await onProgress(0);
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const result = await file.write(buffer, offset, buffer.byteLength - offset);
        if (result.bytesWritten === 0)
          throw new Error("Transfer destination could not be written.");
        offset += result.bytesWritten;
      }
      hash.update(buffer);
      bytes += buffer.byteLength;
      await onProgress(bytes);
    }
    await file.sync();
    await file.close();
    await FSP.rename(temporary, destination);
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    await file.close().catch(() => undefined);
    await FSP.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function incomingResponse(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      value === undefined ||
      ["connection", "content-length", "location", "set-cookie", "transfer-encoding"].includes(name)
    ) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = [204, 205, 304].includes(response.statusCode ?? 0)
    ? null
    : (Readable.toWeb(response) as ReadableStream);
  return new Response(body, { status: response.statusCode ?? 502, headers });
}

function redirectInput<Input extends { url: string; headers?: Record<string, string> }>(
  input: Input,
  previousUrl: URL,
  location: string,
): Input {
  const nextUrl = new URL(location, previousUrl);
  const headers =
    nextUrl.origin === previousUrl.origin
      ? input.headers
      : stripCrossOriginCredentials(input.headers);
  const redirected = { ...input, url: nextUrl.toString() };
  if (headers === undefined) delete redirected.headers;
  else redirected.headers = headers;
  return redirected;
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

async function boundedResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_RESPONSE_BODY_BYTES) throw new Error("App transfer response exceeds 1 MiB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined || name === "set-cookie"
        ? []
        : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ),
  );
}

function isRedirect(status: number | undefined): boolean {
  return status !== undefined && [301, 302, 303, 307, 308].includes(status);
}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

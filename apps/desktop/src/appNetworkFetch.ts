// FILE: appNetworkFetch.ts
// Purpose: Performs bounded, credential-isolated HTTPS requests for granted Apps.
// Layer: Trusted desktop App runtime

import * as DNS from "node:dns/promises";
import * as HTTP from "node:http";
import * as HTTPS from "node:https";
import { isIP } from "node:net";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
  "upgrade",
]);

export interface AppNetworkFetchRequest {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface AppNetworkFetchResponse {
  url: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export async function mediatedAppFetch(
  input: AppNetworkFetchRequest,
): Promise<AppNetworkFetchResponse> {
  return request(input, 0);
}

async function request(
  input: AppNetworkFetchRequest,
  redirects: number,
): Promise<AppNetworkFetchResponse> {
  const url = parseAppNetworkUrl(input.url);
  const method = (input.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error(`Network method ${method} is not supported.`);
  const headers = validateAppNetworkHeaders(input.headers ?? {});
  const body =
    input.body === undefined
      ? null
      : typeof input.body === "string"
        ? Buffer.from(input.body)
        : Buffer.from(input.body);
  if (body && body.byteLength > MAX_BODY_BYTES)
    throw new Error("Network request body exceeds 10 MiB.");
  if ((method === "GET" || method === "HEAD") && body)
    throw new Error(`${method} requests cannot include a body.`);
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 30_000, 1), 60_000);
  const address =
    url.protocol === "http:"
      ? await resolveLoopbackAppNetworkAddress(url.hostname)
      : await resolvePublicAppNetworkAddress(url.hostname);
  const response = await send({ url, address, method, headers, body, timeoutMs });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    if (redirects >= MAX_REDIRECTS) throw new Error("Network request exceeded five redirects.");
    const next = new URL(response.headers.location, url);
    const redirectMethod =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
        ? "GET"
        : method;
    const nextInput: AppNetworkFetchRequest = {
      url: next.toString(),
      method: redirectMethod,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(redirectMethod === "GET" || input.body === undefined ? {} : { body: input.body }),
    };
    return request(nextInput, redirects + 1);
  }
  return { ...response, url: url.toString() };
}

function send(input: {
  url: URL;
  address: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  timeoutMs: number;
}): Promise<Omit<AppNetworkFetchResponse, "url">> {
  return new Promise((resolve, reject) => {
    const transport = input.url.protocol === "http:" ? HTTP : HTTPS;
    const request = transport.request(
      {
        protocol: input.url.protocol,
        hostname: input.address,
        port: input.url.port ? Number(input.url.port) : input.url.protocol === "http:" ? 80 : 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: { ...input.headers, host: input.url.host },
        ...(input.url.protocol === "https:" ? { servername: input.url.hostname } : {}),
        timeout: input.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error("Network response body exceeds 10 MiB."));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(response.headers).flatMap(([name, value]) =>
                value === undefined
                  ? []
                  : [[name, Array.isArray(value) ? value.join(", ") : value]],
              ),
            ),
            body: new Uint8Array(Buffer.concat(chunks)),
          }),
        );
      },
    );
    request.once("timeout", () => request.destroy(new Error("Network request timed out.")));
    request.once("error", reject);
    if (input.body) request.write(input.body);
    request.end();
  });
}

export function parseAppNetworkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Network URL is invalid.");
  }
  const loopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (url.username || url.password) {
    throw new Error("Mediated App requests cannot use embedded credentials.");
  }
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error("Mediated App requests require HTTPS, except for loopback development URLs.");
  }
  return url;
}

async function resolveLoopbackAppNetworkAddress(hostname: string): Promise<string> {
  const normalized = hostname === "[::1]" ? "::1" : hostname;
  const literal = isIP(normalized) ? normalized : null;
  const address = literal ?? (await DNS.lookup(normalized, { verbatim: true })).address;
  if (address !== "::1" && !address.startsWith("127.")) {
    throw new Error("Loopback App requests must resolve to a loopback address.");
  }
  return address;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export async function resolvePublicAppNetworkAddress(hostname: string): Promise<string> {
  const literal = isIP(hostname) ? hostname : null;
  const address = literal ?? (await DNS.lookup(hostname, { verbatim: true })).address;
  if (isPrivateAddress(address))
    throw new Error("Mediated App requests cannot target private or local network addresses.");
  return address;
}

export function isPrivateAddress(address: string): boolean {
  if (
    address === "::1" ||
    address === "::" ||
    address.startsWith("fe80:") ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  )
    return true;
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  const parts = mapped.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const a = parts[0]!;
  const b = parts[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function validateAppNetworkHeaders(
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(normalized) || FORBIDDEN_HEADERS.has(normalized))
      throw new Error(`Network header ${name} is not allowed.`);
    if (typeof value !== "string" || /[\r\n]/u.test(value) || value.length > 8_192)
      throw new Error(`Network header ${name} is invalid.`);
    output[normalized] = value;
  }
  return output;
}

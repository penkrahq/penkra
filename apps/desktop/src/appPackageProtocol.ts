// FILE: appPackageProtocol.ts
// Purpose: Serves App package files with containment and a cache policy safe for mutable sideload URLs.
// Layer: Trusted desktop App runtime

import * as FS from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as Path from "node:path";

import { APP_BLOB_URL_PREFIX, type AppBlobUrlRegistry } from "./appBlobUrlRegistry";
import { appPackageEntityTag, requestAcceptsAppPackageEntityTag } from "./appPackageRevision";
import { resolveAppSpacePackagePath } from "./appRuntimePolicy";

export const APP_FRAME_RUNTIME_PATH = "/.penkra/runtime.js";

const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface AppPackageProtocolInput {
  origin: string;
  packageRoot: string;
  packageSha256: string;
  entrypoint: string;
  runtimeScriptPath?: string;
  blobUrls?: Pick<AppBlobUrlRegistry, "resolve">;
  transferHandler?: (request: Request) => Promise<Response>;
}

export type AppPackageProtocolHandler = (request: Request) => Promise<Response>;

export async function createAppPackageProtocolHandler(
  input: AppPackageProtocolInput,
): Promise<AppPackageProtocolHandler> {
  const canonicalRoot = await FS.promises.realpath(input.packageRoot);
  const packageEntityTag = appPackageEntityTag(input.packageSha256);
  const entrypointPath = resolveAppSpacePackagePath(
    canonicalRoot,
    input.origin,
    `${input.origin}/${input.entrypoint}`,
  );
  await requireContainedRegularFile(canonicalRoot, entrypointPath);
  const runtimeScript = input.runtimeScriptPath
    ? await FS.promises.readFile(await requireHostRuntimeScript(input.runtimeScriptPath))
    : null;

  return async (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname === APP_FRAME_RUNTIME_PATH) {
        if (!runtimeScript) throw new Error("The App frame runtime is unavailable.");
        return new Response(Uint8Array.from(runtimeScript).buffer, {
          status: 200,
          headers: responseHeaders("runtime.js"),
        });
      }
      if (requestUrl.pathname.startsWith(APP_BLOB_URL_PREFIX)) {
        if (!input.blobUrls) throw new Error("The App blob service is unavailable.");
        return await serveAppBlob(input.origin, request, input.blobUrls);
      }
      if (requestUrl.pathname.startsWith("/.penkra/transfer/")) {
        if (!input.transferHandler) throw new Error("The App transfer service is unavailable.");
        return await input.transferHandler(request);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
          status: 405,
          headers: {
            ...responseHeaders("method-not-allowed.txt"),
            "Cache-Control": "no-store",
            Allow: "GET, HEAD",
          },
        });
      }
      const requestedPath = resolveAppSpacePackagePath(canonicalRoot, input.origin, request.url);
      const path = await resolveRequestFile(canonicalRoot, requestedPath, entrypointPath);
      if (
        requestAcceptsAppPackageEntityTag(request.headers.get("if-none-match"), packageEntityTag)
      ) {
        return new Response(null, {
          status: 304,
          headers: packageResponseHeaders(path, packageEntityTag),
        });
      }
      const contents = await FS.promises.readFile(path);
      const body = Uint8Array.from(
        runtimeScript && Path.extname(path).toLowerCase() === ".html"
          ? injectFrameRuntime(contents)
          : contents,
      ).buffer;
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: packageResponseHeaders(path, packageEntityTag),
      });
    } catch {
      return new Response("Not found", {
        status: 404,
        headers: { ...responseHeaders("not-found.txt"), "Cache-Control": "no-store" },
      });
    }
  };
}

async function serveAppBlob(
  origin: string,
  request: Request,
  registry: Pick<AppBlobUrlRegistry, "resolve">,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...responseHeaders("method-not-allowed.txt"), Allow: "GET, HEAD" },
    });
  }
  const url = new URL(request.url);
  assertAssignedOrigin(origin, url);
  const token = url.pathname.slice(APP_BLOB_URL_PREFIX.length);
  const record = registry.resolve(origin, token);
  const canonicalPath = await FS.promises.realpath(record.path);
  if (canonicalPath !== record.path) throw new Error("The App blob target changed.");
  const file = await FS.promises.open(
    canonicalPath,
    FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW,
  );
  let stat: FS.Stats;
  try {
    stat = await file.stat();
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
  if (!stat.isFile()) {
    await file.close();
    throw new Error("The App blob target is not a regular file.");
  }

  const range = parseByteRange(request.headers.get("range"), stat.size);
  if (range === "unsatisfiable") {
    await file.close();
    return new Response(null, {
      status: 416,
      headers: blobHeaders(canonicalPath, 0, { contentRange: `bytes */${stat.size}` }),
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, stat.size - 1);
  const length = stat.size === 0 ? 0 : end - start + 1;
  const headers = blobHeaders(canonicalPath, length, {
    ...(range ? { contentRange: `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  if (request.method === "HEAD" || length === 0) {
    await file.close();
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const body = fileRangeStream(file, start, length);
  return new Response(body, { status: range ? 206 : 200, headers });
}

function fileRangeStream(
  file: FileHandle,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  let position = start;
  let remaining = length;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await file.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining === 0) {
        controller.close();
        await close();
        return;
      }
      const chunk = new Uint8Array(Math.min(64 * 1024, remaining));
      try {
        const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) {
          throw new Error("The App blob target changed while it was streaming.");
        }
        position += bytesRead;
        remaining -= bytesRead;
        controller.enqueue(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
        if (remaining === 0) {
          controller.close();
          await close();
        }
      } catch (error) {
        await close().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });
}

function assertAssignedOrigin(origin: string, url: URL): void {
  const expected = new URL(origin);
  if (url.protocol !== expected.protocol || url.host !== expected.host) {
    throw new Error("The App resource belongs to another origin.");
  }
}

function parseByteRange(
  value: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return "unsatisfiable";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function blobHeaders(path: string, length: number, input: { contentRange?: string }): HeadersInit {
  return {
    ...responseHeaders(path),
    "Accept-Ranges": "bytes",
    "Content-Length": String(length),
    ...(input.contentRange ? { "Content-Range": input.contentRange } : {}),
  };
}

async function requireHostRuntimeScript(path: string): Promise<string> {
  if (!Path.isAbsolute(path)) throw new TypeError("App frame runtime path must be absolute.");
  const canonicalPath = await FS.promises.realpath(path);
  const stats = await FS.promises.stat(canonicalPath);
  if (!stats.isFile()) throw new TypeError("App frame runtime must be a regular file.");
  return canonicalPath;
}

function injectFrameRuntime(contents: Buffer): Uint8Array {
  const html = contents.toString("utf8");
  const script = `<script src="${APP_FRAME_RUNTIME_PATH}"></script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head?.index !== undefined) {
    const insertion = head.index + head[0].length;
    return new TextEncoder().encode(`${html.slice(0, insertion)}${script}${html.slice(insertion)}`);
  }
  return new TextEncoder().encode(`${script}${html}`);
}

async function resolveRequestFile(
  canonicalRoot: string,
  requestedPath: string,
  entrypointPath: string,
): Promise<string> {
  try {
    return await requireContainedRegularFile(canonicalRoot, requestedPath);
  } catch (error) {
    if (Path.extname(requestedPath).length > 0) throw error;
    return requireContainedRegularFile(canonicalRoot, entrypointPath);
  }
}

async function requireContainedRegularFile(
  canonicalRoot: string,
  candidatePath: string,
): Promise<string> {
  const canonicalPath = await FS.promises.realpath(candidatePath);
  if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}${Path.sep}`)) {
    throw new Error("Resolved App package file escapes its verified package root.");
  }
  const stats = await FS.promises.stat(canonicalPath);
  if (!stats.isFile()) throw new Error("App package request does not resolve to a regular file.");
  return canonicalPath;
}

function responseHeaders(path: string): HeadersInit {
  return {
    "Content-Type": contentType(path),
    "Content-Security-Policy": APP_CONTENT_SECURITY_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function packageResponseHeaders(path: string, entityTag: string): HeadersInit {
  return {
    ...responseHeaders(path),
    "Cache-Control": "private, no-cache",
    ETag: entityTag,
  };
}

function contentType(path: string): string {
  switch (Path.extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".pdf":
      return "application/pdf";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

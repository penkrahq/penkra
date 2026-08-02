// FILE: appPackageProtocol.ts
// Purpose: Serves immutable App package files with containment and restrictive response policy.
// Layer: Trusted desktop App runtime

import * as FS from "node:fs";
import * as Path from "node:path";

import { resolveAppPackagePath } from "./appRuntimePolicy";

const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface AppPackageProtocolInput {
  appId: string;
  packageRoot: string;
  entrypoint: string;
}

export type AppPackageProtocolHandler = (request: Request) => Promise<Response>;

export async function createAppPackageProtocolHandler(
  input: AppPackageProtocolInput,
): Promise<AppPackageProtocolHandler> {
  const canonicalRoot = await FS.promises.realpath(input.packageRoot);
  const entrypointPath = resolveAppPackagePath(
    canonicalRoot,
    input.appId,
    `penkra-app://${input.appId}/${input.entrypoint}`,
  );
  await requireContainedRegularFile(canonicalRoot, entrypointPath);

  return async (request) => {
    try {
      const requestedPath = resolveAppPackagePath(canonicalRoot, input.appId, request.url);
      const path = await resolveRequestFile(canonicalRoot, requestedPath, entrypointPath);
      const contents = await FS.promises.readFile(path);
      return new Response(new Uint8Array(contents), {
        status: 200,
        headers: responseHeaders(path),
      });
    } catch {
      return new Response("Not found", {
        status: 404,
        headers: responseHeaders("not-found.txt"),
      });
    }
  };
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
  if (
    canonicalPath !== canonicalRoot &&
    !canonicalPath.startsWith(`${canonicalRoot}${Path.sep}`)
  ) {
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
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

// FILE: appRuntimePolicy.ts
// Purpose: Derives isolated App origins, sessions, renderer preferences, and package paths.
// Layer: Trusted desktop App runtime

import { createHash } from "node:crypto";
import * as Path from "node:path";

export const PENKRA_APP_SCHEME = "penkra-app";
export const APP_SESSION_PARTITION_PREFIX = "persist:penkra-app-";
export const PENKRA_APP_ID_ARGUMENT_PREFIX = "--penkra-app-id=";

export interface AppRendererPreferencesInput {
  appId: string;
  spaceId: string;
  preloadPath: string;
}

export interface AppRendererPreferences {
  partition: string;
  preload: string;
  sandbox: true;
  contextIsolation: true;
  nodeIntegration: false;
  nodeIntegrationInWorker: false;
  nodeIntegrationInSubFrames: false;
  webSecurity: true;
  allowRunningInsecureContent: false;
  webviewTag: false;
  additionalArguments: [string];
}

export type AppNavigationDecision =
  | { action: "allow"; url: URL }
  | { action: "deny"; reason: "invalid-url" | "outside-app-origin" };

export function createAppOrigin(appId: string): string {
  return `${PENKRA_APP_SCHEME}://${normalizeAppId(appId)}`;
}

export function createAppDocumentUrl(appId: string, entrypoint: string): string {
  const origin = createAppOrigin(appId);
  if (!isSafePackageRelativePath(entrypoint)) {
    throw new TypeError("App entrypoint must be a safe package-relative path.");
  }
  return new URL(entrypoint, `${origin}/`).href;
}

export function createAppSessionPartition(appId: string, spaceId: string): string {
  const normalizedAppId = normalizeAppId(appId);
  if (spaceId.trim().length === 0 || spaceId !== spaceId.trim()) {
    throw new TypeError("spaceId must be a non-empty canonical string.");
  }
  const identity = createHash("sha256")
    .update(normalizedAppId)
    .update("\0")
    .update(spaceId)
    .digest("hex");
  return `${APP_SESSION_PARTITION_PREFIX}${identity}`;
}

export function createAppRendererPreferences(
  input: AppRendererPreferencesInput,
): AppRendererPreferences {
  if (!Path.isAbsolute(input.preloadPath)) {
    throw new TypeError("App preloadPath must be absolute and host-owned.");
  }
  return {
    partition: createAppSessionPartition(input.appId, input.spaceId),
    preload: input.preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    additionalArguments: [`${PENKRA_APP_ID_ARGUMENT_PREFIX}${input.appId}`],
  };
}

export function decideAppNavigation(appId: string, candidateUrl: string): AppNavigationDecision {
  let url: URL;
  try {
    url = new URL(candidateUrl);
  } catch {
    return { action: "deny", reason: "invalid-url" };
  }
  if (!belongsToAppOrigin(url, appId)) {
    return { action: "deny", reason: "outside-app-origin" };
  }
  return { action: "allow", url };
}

export function resolveAppPackagePath(
  packageRoot: string,
  appId: string,
  candidateUrl: string,
): string {
  if (!Path.isAbsolute(packageRoot)) {
    throw new TypeError("App package root must be absolute.");
  }
  let url: URL;
  try {
    url = new URL(candidateUrl);
  } catch (error) {
    throw new TypeError("App document URL is invalid.", { cause: error });
  }
  if (!belongsToAppOrigin(url, appId)) {
    throw new TypeError("App document URL does not belong to its assigned App origin.");
  }
  let pathname: string;
  try {
    // WHATWG URL parsing normalizes encoded dot segments. Decode the raw path
    // first so `%2e%2e` cannot disappear before the containment check sees it.
    pathname = decodeURIComponent(rawUrlPathname(candidateUrl));
  } catch (error) {
    throw new TypeError("App document path has invalid percent encoding.", { cause: error });
  }
  if (pathname.includes("\0")) throw new TypeError("App document path contains a NUL byte.");
  if (pathname.includes("\\")) {
    throw new TypeError("App document path contains a platform-dependent separator.");
  }

  const canonicalRoot = Path.resolve(packageRoot);
  const resolvedPath = Path.resolve(canonicalRoot, `.${pathname}`);
  if (resolvedPath !== canonicalRoot && !resolvedPath.startsWith(`${canonicalRoot}${Path.sep}`)) {
    throw new TypeError("App document path escapes its verified package root.");
  }
  return resolvedPath;
}

function rawUrlPathname(candidateUrl: string): string {
  const authorityStart = candidateUrl.indexOf("://");
  const pathStart = candidateUrl.indexOf("/", authorityStart + 3);
  if (pathStart < 0) return "/";
  const queryStart = candidateUrl.indexOf("?", pathStart);
  const fragmentStart = candidateUrl.indexOf("#", pathStart);
  const candidates = [queryStart, fragmentStart].filter((index) => index >= 0);
  const pathEnd = candidates.length === 0 ? candidateUrl.length : Math.min(...candidates);
  return candidateUrl.slice(pathStart, pathEnd);
}

function normalizeAppId(appId: string): string {
  if (appId !== appId.trim().toLowerCase()) {
    throw new TypeError("appId must be a lowercase reverse-domain identifier.");
  }
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/.test(appId)) {
    throw new TypeError("appId must be a lowercase reverse-domain identifier.");
  }
  return appId;
}

function isSafePackageRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return false;
  }
  return !value.split(/[\\/]/).some((segment) => segment === ".." || segment.length === 0);
}

function belongsToAppOrigin(url: URL, appId: string): boolean {
  return (
    url.protocol === `${PENKRA_APP_SCHEME}:` &&
    url.hostname === normalizeAppId(appId) &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

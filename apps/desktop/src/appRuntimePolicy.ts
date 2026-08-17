// FILE: appRuntimePolicy.ts
// Purpose: Derives isolated App origins, sessions, renderer preferences, and package paths.
// Layer: Trusted desktop App runtime

import { createHash, createHmac } from "node:crypto";
import * as Path from "node:path";

export const PENKRA_APP_SCHEME = "penkra-app";
export const PENKRA_APP_SPACE_ORIGIN_HOST_PREFIX = "a-";
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

/**
 * Derives a stable, non-enumerable origin host for one App installation scope.
 * The host deliberately contains neither the App ID nor the Space ID; callers
 * must persist the installation secret and never expose it to an App renderer.
 */
export function deriveAppSpaceOriginHost(
  installationSecret: Uint8Array,
  appId: string,
  spaceId: string,
): string {
  if (installationSecret.byteLength < 32) {
    throw new TypeError("App origin installation secret must contain at least 32 bytes.");
  }
  const normalizedAppId = normalizeAppId(appId);
  const normalizedSpaceId = normalizeSpaceId(spaceId);
  const digest = createHmac("sha256", installationSecret)
    .update("app-space-origin\0")
    .update(normalizedAppId)
    .update("\0")
    .update(normalizedSpaceId)
    .digest("hex");
  return `${PENKRA_APP_SPACE_ORIGIN_HOST_PREFIX}${digest}`;
}

export function createAppSpaceOrigin(
  installationSecret: Uint8Array,
  appId: string,
  spaceId: string,
): string {
  return `${PENKRA_APP_SCHEME}://${deriveAppSpaceOriginHost(installationSecret, appId, spaceId)}`;
}

export function createAppSpaceDocumentUrl(
  installationSecret: Uint8Array,
  appId: string,
  spaceId: string,
  entrypoint: string,
): string {
  if (!isSafePackageRelativePath(entrypoint)) {
    throw new TypeError("App entrypoint must be a safe package-relative path.");
  }
  return new URL(entrypoint, `${createAppSpaceOrigin(installationSecret, appId, spaceId)}/`).href;
}

export function createAppDocumentUrlForOrigin(assignedOrigin: string, entrypoint: string): string {
  if (!isSafePackageRelativePath(entrypoint)) {
    throw new TypeError("App entrypoint must be a safe package-relative path.");
  }
  return new URL(entrypoint, `${normalizeAppSpaceOrigin(assignedOrigin)}/`).href;
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
  const normalizedSpaceId = normalizeSpaceId(spaceId);
  const identity = createHash("sha256")
    .update(normalizedAppId)
    .update("\0")
    .update(normalizedSpaceId)
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
  return decideNavigationForOrigin(createAppOrigin(appId), candidateUrl);
}

export function decideAppSpaceNavigation(
  assignedOrigin: string,
  candidateUrl: string,
): AppNavigationDecision {
  return decideNavigationForOrigin(normalizeAppSpaceOrigin(assignedOrigin), candidateUrl);
}

function decideNavigationForOrigin(
  assignedOrigin: string,
  candidateUrl: string,
): AppNavigationDecision {
  let url: URL;
  try {
    url = new URL(candidateUrl);
  } catch {
    return { action: "deny", reason: "invalid-url" };
  }
  if (!belongsToAssignedOrigin(url, assignedOrigin)) {
    return { action: "deny", reason: "outside-app-origin" };
  }
  return { action: "allow", url };
}

export function resolveAppPackagePath(
  packageRoot: string,
  appId: string,
  candidateUrl: string,
): string {
  let url: URL;
  try {
    url = new URL(candidateUrl);
  } catch (error) {
    throw new TypeError("App document URL is invalid.", { cause: error });
  }
  if (!belongsToAppOrigin(url, appId)) {
    throw new TypeError("App document URL does not belong to its assigned App origin.");
  }
  return resolveContainedUrlPath(packageRoot, candidateUrl);
}

function resolveContainedUrlPath(packageRoot: string, candidateUrl: string): string {
  if (!Path.isAbsolute(packageRoot)) {
    throw new TypeError("App package root must be absolute.");
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

export function resolveAppSpacePackagePath(
  packageRoot: string,
  assignedOrigin: string,
  candidateUrl: string,
): string {
  return resolvePackagePathForOrigin(
    packageRoot,
    normalizeAppSpaceOrigin(assignedOrigin),
    candidateUrl,
  );
}

function resolvePackagePathForOrigin(
  packageRoot: string,
  assignedOrigin: string,
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
  if (!belongsToAssignedOrigin(url, assignedOrigin)) {
    throw new TypeError("App document URL does not belong to its assigned App origin.");
  }
  return resolveContainedUrlPath(packageRoot, candidateUrl);
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

function normalizeSpaceId(spaceId: string): string {
  if (spaceId.trim().length === 0 || spaceId !== spaceId.trim()) {
    throw new TypeError("spaceId must be a non-empty canonical string.");
  }
  return spaceId;
}

function normalizeAppSpaceOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new TypeError("App Space origin is invalid.", { cause: error });
  }
  if (
    url.protocol !== `${PENKRA_APP_SCHEME}:` ||
    !new RegExp(`^${PENKRA_APP_SPACE_ORIGIN_HOST_PREFIX}[a-f0-9]{64}$`).test(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("App Space origin must be a canonical host-minted origin.");
  }
  return `${PENKRA_APP_SCHEME}://${url.hostname}`;
}

function belongsToAssignedOrigin(url: URL, assignedOrigin: string): boolean {
  const assigned = new URL(assignedOrigin);
  return (
    url.protocol === assigned.protocol &&
    url.hostname === assigned.hostname &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
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

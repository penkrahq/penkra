// FILE: appInstallationState.ts
// Purpose: Owns pure transitions for profile-installed App packages and Space-scoped App state.
// Layer: Trusted desktop App runtime

import { assertAppManifest, type PenkraAppManifest } from "@penkra/sdk";

export const APP_INSTALLATION_STATE_SCHEMA_VERSION = 1 as const;

export type InstalledAppSource = "registry" | "sideload";
export type AppPermissionGrant = "denied" | "granted";

export interface InstalledAppPackage {
  appId: string;
  slug: string;
  name: string;
  summary: string;
  version: string;
  source: InstalledAppSource;
  packagePath: string;
  sha256: string;
  installedAt: string;
  /** Exact validated manifest committed with these immutable package bytes. */
  manifest: PenkraAppManifest;
  registryRelease?: {
    appId: string;
    versionId: string;
    packageDigest: string;
    keyId: string;
    publishedAt: string;
  };
}

export interface SpaceAppState {
  appId: string;
  spaceId: string;
  enabled: boolean;
  permissions: Readonly<Record<string, AppPermissionGrant>>;
}

export interface AppInstallationState {
  schemaVersion: typeof APP_INSTALLATION_STATE_SCHEMA_VERSION;
  packagesByAppId: Readonly<Record<string, InstalledAppPackage>>;
  spaceStateByKey: Readonly<Record<string, SpaceAppState>>;
}

export type AppInstallationStateErrorCode =
  | "app-already-installed"
  | "app-not-installed"
  | "invalid-state"
  | "slug-collision"
  | "source-mismatch";

export class AppInstallationStateError extends Error {
  readonly code: AppInstallationStateErrorCode;

  constructor(code: AppInstallationStateErrorCode, message: string) {
    super(message);
    this.name = "AppInstallationStateError";
    this.code = code;
  }
}

export interface VerifiedAppPackageInput {
  manifest: PenkraAppManifest;
  source: InstalledAppSource;
  /** Host-owned package location after identity, integrity, and compatibility verification. */
  packagePath: string;
  /** Lowercase hexadecimal SHA-256 of the immutable package bytes. */
  sha256: string;
  installedAt: string;
  registryRelease?: InstalledAppPackage["registryRelease"];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID_PATTERN = /^[a-f0-9]{16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstalledAppSource(value: unknown): value is InstalledAppSource {
  return value === "registry" || value === "sideload";
}

function isPermissionGrant(value: unknown): value is AppPermissionGrant {
  return value === "denied" || value === "granted";
}

function spaceAppStateKey(spaceId: string, appId: string): string {
  return `${spaceId}\u0000${appId}`;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppInstallationStateError("invalid-state", `${label} must be a non-empty string.`);
  }
  return value;
}

function parseInstalledPackage(value: unknown, recordKey: string): InstalledAppPackage {
  if (!isRecord(value)) {
    throw new AppInstallationStateError("invalid-state", `Package ${recordKey} must be an object.`);
  }
  const appId = requireNonEmptyString(value.appId, `Package ${recordKey} appId`);
  if (appId !== recordKey) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package record key ${recordKey} does not match appId ${appId}.`,
    );
  }
  const source = value.source;
  if (!isInstalledAppSource(source)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} has an invalid source.`,
    );
  }
  const sha256 = requireNonEmptyString(value.sha256, `Package ${recordKey} sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} sha256 must be lowercase hexadecimal SHA-256.`,
    );
  }
  try {
    assertAppManifest(value.manifest);
  } catch (error) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const installedPackage: InstalledAppPackage = {
    appId,
    slug: requireNonEmptyString(value.slug, `Package ${recordKey} slug`),
    name: requireNonEmptyString(value.name, `Package ${recordKey} name`),
    summary: requireNonEmptyString(value.summary, `Package ${recordKey} summary`),
    version: requireNonEmptyString(value.version, `Package ${recordKey} version`),
    source,
    packagePath: requireNonEmptyString(value.packagePath, `Package ${recordKey} packagePath`),
    sha256,
    installedAt: requireNonEmptyString(value.installedAt, `Package ${recordKey} installedAt`),
    manifest: value.manifest,
    ...(value.registryRelease === undefined
      ? {}
      : { registryRelease: parseRegistryRelease(value.registryRelease, recordKey) }),
  };
  if (
    installedPackage.manifest.id !== installedPackage.appId ||
    installedPackage.manifest.slug !== installedPackage.slug ||
    installedPackage.manifest.name !== installedPackage.name ||
    installedPackage.manifest.summary !== installedPackage.summary ||
    installedPackage.manifest.version !== installedPackage.version
  ) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} metadata does not match its committed manifest.`,
    );
  }
  if (installedPackage.registryRelease && installedPackage.source !== "registry") {
    throw new AppInstallationStateError("invalid-state", `Package ${recordKey} has registry evidence but is not registry sourced.`);
  }
  return installedPackage;
}

function parseSpaceState(value: unknown, recordKey: string): SpaceAppState {
  if (!isRecord(value)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Space App state ${recordKey} must be an object.`,
    );
  }
  const appId = requireNonEmptyString(value.appId, `Space App state ${recordKey} appId`);
  const spaceId = requireNonEmptyString(value.spaceId, `Space App state ${recordKey} spaceId`);
  if (spaceAppStateKey(spaceId, appId) !== recordKey) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Space App state key ${recordKey} does not match its Space and App.`,
    );
  }
  if (typeof value.enabled !== "boolean") {
    throw new AppInstallationStateError(
      "invalid-state",
      `Space App state ${recordKey} enabled must be a boolean.`,
    );
  }
  if (!isRecord(value.permissions)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Space App state ${recordKey} permissions must be an object.`,
    );
  }
  const permissions: Record<string, AppPermissionGrant> = {};
  for (const [permission, grant] of Object.entries(value.permissions)) {
    if (!isPermissionGrant(grant)) {
      throw new AppInstallationStateError(
        "invalid-state",
        `Space App state ${recordKey} has an invalid ${permission} grant.`,
      );
    }
    permissions[permission] = grant;
  }
  return { appId, spaceId, enabled: value.enabled, permissions };
}

export function createEmptyAppInstallationState(): AppInstallationState {
  return {
    schemaVersion: APP_INSTALLATION_STATE_SCHEMA_VERSION,
    packagesByAppId: {},
    spaceStateByKey: {},
  };
}

export function parseAppInstallationState(value: unknown): AppInstallationState {
  if (!isRecord(value) || value.schemaVersion !== APP_INSTALLATION_STATE_SCHEMA_VERSION) {
    throw new AppInstallationStateError(
      "invalid-state",
      `App installation state schemaVersion must be ${APP_INSTALLATION_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (!isRecord(value.packagesByAppId) || !isRecord(value.spaceStateByKey)) {
    throw new AppInstallationStateError(
      "invalid-state",
      "App installation state package and Space records must be objects.",
    );
  }
  const packagesByAppId = Object.fromEntries(
    Object.entries(value.packagesByAppId).map(([appId, candidate]) => [
      appId,
      parseInstalledPackage(candidate, appId),
    ]),
  );
  const seenSlugs = new Set<string>();
  for (const installedPackage of Object.values(packagesByAppId)) {
    if (seenSlugs.has(installedPackage.slug)) {
      throw new AppInstallationStateError(
        "invalid-state",
        `Installed App slug ${installedPackage.slug} is not unique.`,
      );
    }
    seenSlugs.add(installedPackage.slug);
  }
  const spaceStateByKey = Object.fromEntries(
    Object.entries(value.spaceStateByKey).map(([key, candidate]) => [
      key,
      parseSpaceState(candidate, key),
    ]),
  );
  return {
    schemaVersion: APP_INSTALLATION_STATE_SCHEMA_VERSION,
    packagesByAppId,
    spaceStateByKey,
  };
}

function toInstalledPackage(input: VerifiedAppPackageInput): InstalledAppPackage {
  assertAppManifest(input.manifest);
  if (!SHA256_PATTERN.test(input.sha256)) {
    throw new AppInstallationStateError(
      "invalid-state",
      "Verified package sha256 must be lowercase hexadecimal SHA-256.",
    );
  }
  if (input.registryRelease && input.source !== "registry") {
    throw new AppInstallationStateError("invalid-state", "Only registry packages may carry registry release evidence.");
  }
  return {
    appId: input.manifest.id,
    slug: input.manifest.slug,
    name: input.manifest.name,
    summary: input.manifest.summary,
    version: input.manifest.version,
    source: input.source,
    packagePath: input.packagePath,
    sha256: input.sha256,
    installedAt: input.installedAt,
    manifest: input.manifest,
    ...(input.registryRelease === undefined
      ? {}
      : { registryRelease: parseRegistryRelease(input.registryRelease, input.manifest.id) }),
  };
}

function parseRegistryRelease(value: unknown, recordKey: string): NonNullable<InstalledAppPackage["registryRelease"]> {
  if (!isRecord(value)) {
    throw new AppInstallationStateError("invalid-state", `Package ${recordKey} registry release must be an object.`);
  }
  const packageDigest = requireNonEmptyString(value.packageDigest, `Package ${recordKey} registry package digest`);
  if (!SHA256_PATTERN.test(packageDigest)) {
    throw new AppInstallationStateError("invalid-state", `Package ${recordKey} registry package digest is invalid.`);
  }
  const appId = requireNonEmptyString(value.appId, `Package ${recordKey} registry App id`);
  const versionId = requireNonEmptyString(value.versionId, `Package ${recordKey} registry version id`);
  const keyId = requireNonEmptyString(value.keyId, `Package ${recordKey} registry key id`);
  const publishedAt = requireNonEmptyString(value.publishedAt, `Package ${recordKey} registry publication time`);
  if (!UUID_PATTERN.test(appId) || !UUID_PATTERN.test(versionId) || !KEY_ID_PATTERN.test(keyId) || !Number.isFinite(Date.parse(publishedAt))) {
    throw new AppInstallationStateError("invalid-state", `Package ${recordKey} registry release identity is invalid.`);
  }
  return {
    appId,
    versionId,
    packageDigest,
    keyId,
    publishedAt,
  };
}

export function registerVerifiedAppPackage(
  state: AppInstallationState,
  input: VerifiedAppPackageInput,
): AppInstallationState {
  const installedPackage = toInstalledPackage(input);
  const existing = state.packagesByAppId[installedPackage.appId];
  if (existing) {
    throw new AppInstallationStateError(
      "app-already-installed",
      `${installedPackage.appId} is already installed; update or uninstall it explicitly.`,
    );
  }
  const slugOwner = Object.values(state.packagesByAppId).find(
    (candidate) => candidate.slug === installedPackage.slug,
  );
  if (slugOwner) {
    throw new AppInstallationStateError(
      "slug-collision",
      `Slug ${installedPackage.slug} is already owned by ${slugOwner.appId}.`,
    );
  }
  return {
    ...state,
    packagesByAppId: { ...state.packagesByAppId, [installedPackage.appId]: installedPackage },
  };
}

export function replaceVerifiedRegistryAppPackage(
  state: AppInstallationState,
  input: VerifiedAppPackageInput & { source: "registry" },
): AppInstallationState {
  const installedPackage = toInstalledPackage(input);
  const existing = state.packagesByAppId[installedPackage.appId];
  if (!existing) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${installedPackage.appId} is not installed.`,
    );
  }
  if (existing.source !== "registry" || existing.slug !== installedPackage.slug) {
    throw new AppInstallationStateError(
      "source-mismatch",
      "Registry updates cannot replace a sideload or change an installed App slug.",
    );
  }
  return {
    ...state,
    packagesByAppId: { ...state.packagesByAppId, [installedPackage.appId]: installedPackage },
  };
}

export function unregisterAppPackage(
  state: AppInstallationState,
  appId: string,
): AppInstallationState {
  if (!state.packagesByAppId[appId]) return state;
  const packagesByAppId = { ...state.packagesByAppId };
  delete packagesByAppId[appId];
  return { ...state, packagesByAppId };
}

export function setSpaceAppEnabled(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; enabled: boolean },
): AppInstallationState {
  if (!state.packagesByAppId[input.appId]) {
    throw new AppInstallationStateError("app-not-installed", `${input.appId} is not installed.`);
  }
  const key = spaceAppStateKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key];
  const next: SpaceAppState = {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: input.enabled,
    permissions: current?.permissions ?? {},
  };
  return { ...state, spaceStateByKey: { ...state.spaceStateByKey, [key]: next } };
}

export function setSpaceAppPermission(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; permission: string; grant: AppPermissionGrant },
): AppInstallationState {
  if (!state.packagesByAppId[input.appId]) {
    throw new AppInstallationStateError("app-not-installed", `${input.appId} is not installed.`);
  }
  const key = spaceAppStateKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key] ?? {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: false,
    permissions: {},
  };
  const next: SpaceAppState = {
    ...current,
    permissions: { ...current.permissions, [input.permission]: input.grant },
  };
  return { ...state, spaceStateByKey: { ...state.spaceStateByKey, [key]: next } };
}

export function removeRetainedAppState(
  state: AppInstallationState,
  input: { appId: string; spaceId?: string },
): AppInstallationState {
  const spaceStateByKey = Object.fromEntries(
    Object.entries(state.spaceStateByKey).filter(([, candidate]) => {
      if (candidate.appId !== input.appId) return true;
      return input.spaceId !== undefined && candidate.spaceId !== input.spaceId;
    }),
  );
  return { ...state, spaceStateByKey };
}

// FILE: appInstallationState.ts
// Purpose: Owns pure transitions for per-Space App installations and retained App state.
// Layer: Trusted desktop App runtime

import { assertAppManifest, type PenkraAppManifest } from "@penkra/sdk";

export const APP_INSTALLATION_STATE_SCHEMA_VERSION = 5 as const;

export type InstalledAppSource = "registry" | "sideload";
export type AppPermissionGrant = "denied" | "granted";

export interface RegistryAppIdentity {
  appId: string;
  publisherId: string;
}

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
    publisherId?: string;
    packageDigest: string;
    keyId: string;
    publishedAt: string;
  };
  /** Registry ownership proven independently of the currently installed package bytes. */
  registryIdentity?: RegistryAppIdentity;
}

export interface SpaceAppState {
  appId: string;
  spaceId: string;
  enabled: boolean;
  permissions: Readonly<Record<string, AppPermissionGrant>>;
  /** Non-sensitive manifest-declared setting values. Sensitive values live in the encrypted vault. */
  settings: Readonly<Record<string, boolean | number | string>>;
  /** Last applied declaration migration ID by setting key. */
  settingMigrations: Readonly<Record<string, string>>;
  /** Per-Space overrides for App-contributed Agent Skills. Undeclared entries are invalid. */
  skills: Readonly<Record<string, boolean>>;
}

export interface AppInstallationState {
  schemaVersion: typeof APP_INSTALLATION_STATE_SCHEMA_VERSION;
  /** Installed package/version for each Space × App pair. Package paths may be shared by digest. */
  packagesByInstallationKey: Readonly<Record<string, InstalledAppPackage>>;
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
  registryIdentity?: RegistryAppIdentity;
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

export function appInstallationKey(spaceId: string, appId: string): string {
  return `${spaceId}\u0000${appId}`;
}

function parseAppInstallationKey(recordKey: string): { spaceId: string; appId: string } {
  const separator = recordKey.indexOf("\u0000");
  if (separator <= 0 || separator !== recordKey.lastIndexOf("\u0000")) {
    throw new AppInstallationStateError(
      "invalid-state",
      `App installation key ${recordKey} is invalid.`,
    );
  }
  return {
    spaceId: requireNonEmptyString(recordKey.slice(0, separator), "Installation Space id"),
    appId: requireNonEmptyString(recordKey.slice(separator + 1), "Installation App id"),
  };
}

export function getInstalledAppPackage(
  state: AppInstallationState,
  appId: string,
  spaceId: string,
): InstalledAppPackage | undefined {
  return state.packagesByInstallationKey[appInstallationKey(spaceId, appId)];
}

export function findInstalledAppBySlug(
  state: AppInstallationState,
  slug: string,
  spaceId: string,
): InstalledAppPackage | undefined {
  return Object.entries(state.packagesByInstallationKey).find(
    ([key, candidate]) =>
      parseAppInstallationKey(key).spaceId === spaceId && candidate.slug === slug,
  )?.[1];
}

export function listInstalledAppsForSpace(
  state: AppInstallationState,
  spaceId: string,
): ReadonlyArray<InstalledAppPackage> {
  return Object.entries(state.packagesByInstallationKey)
    .filter(([key]) => parseAppInstallationKey(key).spaceId === spaceId)
    .map(([, installed]) => installed);
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
  const registryRelease =
    value.registryRelease === undefined
      ? undefined
      : parseRegistryRelease(value.registryRelease, recordKey);
  const registryIdentity =
    value.registryIdentity === undefined
      ? registryRelease?.publisherId
        ? { appId: registryRelease.appId, publisherId: registryRelease.publisherId }
        : undefined
      : parseRegistryIdentity(value.registryIdentity, recordKey);
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
    ...(registryRelease === undefined ? {} : { registryRelease }),
    ...(registryIdentity === undefined ? {} : { registryIdentity }),
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
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} has registry evidence but is not registry sourced.`,
    );
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
  if (appInstallationKey(spaceId, appId) !== recordKey) {
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
  if (!isRecord(value.settings) || !isRecord(value.settingMigrations) || !isRecord(value.skills)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Space App state ${recordKey} settings, migrations, and skills must be objects.`,
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
  const settings: Record<string, boolean | number | string> = {};
  for (const [key, setting] of Object.entries(value.settings)) {
    if (
      typeof setting !== "boolean" &&
      typeof setting !== "number" &&
      typeof setting !== "string"
    ) {
      throw new AppInstallationStateError(
        "invalid-state",
        `Space App setting ${key} has an invalid value.`,
      );
    }
    settings[key] = setting;
  }
  const settingMigrations: Record<string, string> = {};
  for (const [key, migrationId] of Object.entries(value.settingMigrations)) {
    settingMigrations[key] = requireNonEmptyString(
      migrationId,
      `Space App setting ${key} migration ID`,
    );
  }
  const skills: Record<string, boolean> = {};
  for (const [path, enabled] of Object.entries(value.skills)) {
    if (typeof enabled !== "boolean") {
      throw new AppInstallationStateError(
        "invalid-state",
        `Space App skill ${path} has an invalid state.`,
      );
    }
    skills[path] = enabled;
  }
  return {
    appId,
    spaceId,
    enabled: value.enabled,
    permissions,
    settings,
    settingMigrations,
    skills,
  };
}

export function createEmptyAppInstallationState(): AppInstallationState {
  return {
    schemaVersion: APP_INSTALLATION_STATE_SCHEMA_VERSION,
    packagesByInstallationKey: {},
    spaceStateByKey: {},
  };
}

export function parseAppInstallationState(value: unknown): AppInstallationState {
  if (isRecord(value) && value.schemaVersion === 1) value = migrateSchemaVersionOne(value);
  if (isRecord(value) && value.schemaVersion === 2) value = migrateSchemaVersionTwo(value);
  if (isRecord(value) && value.schemaVersion === 3) value = migrateSchemaVersionThree(value);
  if (isRecord(value) && value.schemaVersion === 4) value = migrateSchemaVersionFour(value);
  if (!isRecord(value) || value.schemaVersion !== APP_INSTALLATION_STATE_SCHEMA_VERSION) {
    throw new AppInstallationStateError(
      "invalid-state",
      `App installation state schemaVersion must be ${APP_INSTALLATION_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (!isRecord(value.packagesByInstallationKey) || !isRecord(value.spaceStateByKey)) {
    throw new AppInstallationStateError(
      "invalid-state",
      "App installation state package and Space records must be objects.",
    );
  }
  const packagesByInstallationKey = Object.fromEntries(
    Object.entries(value.packagesByInstallationKey).map(([key, candidate]) => {
      const { appId } = parseAppInstallationKey(key);
      return [key, parseInstalledPackage(candidate, appId)];
    }),
  );
  const seenSlugs = new Set<string>();
  for (const [key, installedPackage] of Object.entries(packagesByInstallationKey)) {
    const { spaceId } = parseAppInstallationKey(key);
    const scopedSlug = `${spaceId}\u0000${installedPackage.slug}`;
    if (seenSlugs.has(scopedSlug)) {
      throw new AppInstallationStateError(
        "invalid-state",
        `Installed App slug ${installedPackage.slug} is not unique in Space ${spaceId}.`,
      );
    }
    seenSlugs.add(scopedSlug);
  }
  const spaceStateByKey = Object.fromEntries(
    Object.entries(value.spaceStateByKey).map(([key, candidate]) => [
      key,
      parseSpaceState(candidate, key),
    ]),
  );
  for (const space of Object.values(spaceStateByKey)) {
    const installed = getInstalledAppPackage(
      {
        schemaVersion: APP_INSTALLATION_STATE_SCHEMA_VERSION,
        packagesByInstallationKey,
        spaceStateByKey,
      },
      space.appId,
      space.spaceId,
    );
    const declared = new Set(
      (installed?.manifest.contributions?.skills ?? []).map((skill) => skill.path),
    );
    for (const path of Object.keys(space.skills)) {
      if (!declared.has(path)) {
        throw new AppInstallationStateError(
          "invalid-state",
          `Space App state for ${space.appId} contains undeclared skill ${path}.`,
        );
      }
    }
  }
  return {
    schemaVersion: APP_INSTALLATION_STATE_SCHEMA_VERSION,
    packagesByInstallationKey,
    spaceStateByKey,
  };
}

function migrateSchemaVersionOne(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.spaceStateByKey)) {
    throw new AppInstallationStateError(
      "invalid-state",
      "App installation state Space records must be an object.",
    );
  }
  return {
    ...value,
    schemaVersion: 2,
    spaceStateByKey: Object.fromEntries(
      Object.entries(value.spaceStateByKey).map(([key, candidate]) => [
        key,
        isRecord(candidate)
          ? { ...candidate, settings: {}, settingMigrations: {}, skills: {} }
          : candidate,
      ]),
    ),
  };
}

function migrateSchemaVersionTwo(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.packagesByAppId) || !isRecord(value.spaceStateByKey)) {
    throw new AppInstallationStateError(
      "invalid-state",
      "App installation state package and Space records must be objects.",
    );
  }
  const packagesByInstallationKey: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value.spaceStateByKey)) {
    if (!isRecord(candidate)) continue;
    const appId = requireNonEmptyString(candidate.appId, `Space App state ${key} appId`);
    const installed = value.packagesByAppId[appId];
    if (installed !== undefined) packagesByInstallationKey[key] = installed;
  }
  const { packagesByAppId: _legacyPackages, ...current } = value;
  return {
    ...current,
    schemaVersion: 3,
    packagesByInstallationKey,
  };
}

function migrateSchemaVersionThree(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.packagesByInstallationKey)) {
    throw new AppInstallationStateError(
      "invalid-state",
      "App installation state package records must be an object.",
    );
  }
  return {
    ...value,
    schemaVersion: 4,
  };
}

function migrateSchemaVersionFour(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.packagesByInstallationKey)) {
    throw new AppInstallationStateError(
      "invalid-state",
      "App installation state package records must be an object.",
    );
  }
  return {
    ...value,
    schemaVersion: APP_INSTALLATION_STATE_SCHEMA_VERSION,
    packagesByInstallationKey: Object.fromEntries(
      Object.entries(value.packagesByInstallationKey).flatMap(([key, candidate]) => {
        if (!isRecord(candidate) || !isRecord(candidate.manifest)) return [[key, candidate]];
        const manifest = candidate.manifest;
        if (!isRecord(manifest.entrypoints)) return [[key, candidate]];
        const { manifestVersion: _manifestVersion, entrypoints, ...currentManifest } = manifest;
        const tab = entrypoints.tab ?? entrypoints.app;
        const controller = entrypoints.controller ?? entrypoints.operations;
        if (
          entrypoints.controller === undefined &&
          typeof entrypoints.operations === "string" &&
          /\.html?$/iu.test(entrypoints.operations)
        ) {
          // Schema v4 allowed renderer-hosted operation pages. Schema v5 controllers are
          // host-loaded Node modules, so those package bytes cannot be reinterpreted safely.
          // Drop only that package record; its Space state remains as retained App data.
          return [];
        }
        return [
          [
            key,
            {
              ...candidate,
              manifest: {
                ...currentManifest,
                entrypoints: {
                  ...(tab === undefined ? {} : { tab }),
                  ...(controller === undefined ? {} : { controller }),
                },
              },
            },
          ],
        ];
      }),
    ),
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
    throw new AppInstallationStateError(
      "invalid-state",
      "Only registry packages may carry registry release evidence.",
    );
  }
  const registryRelease =
    input.registryRelease === undefined
      ? undefined
      : parseRegistryRelease(input.registryRelease, input.manifest.id);
  const registryIdentity =
    input.registryIdentity === undefined
      ? registryRelease?.publisherId
        ? { appId: registryRelease.appId, publisherId: registryRelease.publisherId }
        : undefined
      : parseRegistryIdentity(input.registryIdentity, input.manifest.id);
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
    ...(registryRelease === undefined ? {} : { registryRelease }),
    ...(registryIdentity === undefined ? {} : { registryIdentity }),
  };
}

function parseRegistryIdentity(value: unknown, recordKey: string): RegistryAppIdentity {
  if (!isRecord(value)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} registry identity must be an object.`,
    );
  }
  const appId = requireNonEmptyString(value.appId, `Package ${recordKey} registry App id`);
  const publisherId = requireNonEmptyString(
    value.publisherId,
    `Package ${recordKey} registry publisher id`,
  );
  if (!UUID_PATTERN.test(appId) || !UUID_PATTERN.test(publisherId)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} registry identity is invalid.`,
    );
  }
  return { appId, publisherId };
}

function parseRegistryRelease(
  value: unknown,
  recordKey: string,
): NonNullable<InstalledAppPackage["registryRelease"]> {
  if (!isRecord(value)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} registry release must be an object.`,
    );
  }
  const packageDigest = requireNonEmptyString(
    value.packageDigest,
    `Package ${recordKey} registry package digest`,
  );
  if (!SHA256_PATTERN.test(packageDigest)) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} registry package digest is invalid.`,
    );
  }
  const appId = requireNonEmptyString(value.appId, `Package ${recordKey} registry App id`);
  const versionId = requireNonEmptyString(
    value.versionId,
    `Package ${recordKey} registry version id`,
  );
  const publisherId =
    value.publisherId === undefined
      ? undefined
      : requireNonEmptyString(value.publisherId, `Package ${recordKey} registry publisher id`);
  const keyId = requireNonEmptyString(value.keyId, `Package ${recordKey} registry key id`);
  const publishedAt = requireNonEmptyString(
    value.publishedAt,
    `Package ${recordKey} registry publication time`,
  );
  if (
    !UUID_PATTERN.test(appId) ||
    !UUID_PATTERN.test(versionId) ||
    (publisherId !== undefined && !UUID_PATTERN.test(publisherId)) ||
    !KEY_ID_PATTERN.test(keyId) ||
    !Number.isFinite(Date.parse(publishedAt))
  ) {
    throw new AppInstallationStateError(
      "invalid-state",
      `Package ${recordKey} registry release identity is invalid.`,
    );
  }
  return {
    appId,
    versionId,
    ...(publisherId === undefined ? {} : { publisherId }),
    packageDigest,
    keyId,
    publishedAt,
  };
}

export function registerVerifiedAppPackage(
  state: AppInstallationState,
  input: VerifiedAppPackageInput,
  spaceId: string,
): AppInstallationState {
  const installedPackage = toInstalledPackage(input);
  const key = appInstallationKey(spaceId, installedPackage.appId);
  const existing = state.packagesByInstallationKey[key];
  if (existing) {
    throw new AppInstallationStateError(
      "app-already-installed",
      `${installedPackage.appId} is already installed in Space ${spaceId}; update or uninstall it explicitly.`,
    );
  }
  const slugOwner = listInstalledAppsForSpace(state, spaceId).find(
    (candidate) => candidate.slug === installedPackage.slug,
  );
  if (slugOwner) {
    throw new AppInstallationStateError(
      "slug-collision",
      `Slug ${installedPackage.slug} is already owned by ${slugOwner.appId} in Space ${spaceId}.`,
    );
  }
  const currentSpaceState = state.spaceStateByKey[key];
  return {
    ...state,
    packagesByInstallationKey: {
      ...state.packagesByInstallationKey,
      [key]: installedPackage,
    },
    spaceStateByKey: {
      ...state.spaceStateByKey,
      [key]: currentSpaceState ?? {
        appId: installedPackage.appId,
        spaceId,
        enabled: false,
        permissions: {},
        settings: {},
        settingMigrations: {},
        skills: {},
      },
    },
  };
}

export function replaceVerifiedRegistryAppPackage(
  state: AppInstallationState,
  input: VerifiedAppPackageInput & { source: "registry" },
  spaceId: string,
): AppInstallationState {
  return replaceVerifiedAppPackage(state, input, spaceId);
}

export function replaceVerifiedAppPackage(
  state: AppInstallationState,
  input: VerifiedAppPackageInput,
  spaceId: string,
): AppInstallationState {
  const installedPackage = toInstalledPackage(input);
  const key = appInstallationKey(spaceId, installedPackage.appId);
  const existing = state.packagesByInstallationKey[key];
  if (!existing) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${installedPackage.appId} is not installed in Space ${spaceId}.`,
    );
  }
  if (existing.source !== installedPackage.source || existing.slug !== installedPackage.slug) {
    throw new AppInstallationStateError(
      "source-mismatch",
      "App updates cannot change package source or the installed App slug.",
    );
  }
  return {
    ...state,
    packagesByInstallationKey: {
      ...state.packagesByInstallationKey,
      [key]: installedPackage,
    },
  };
}

export function setSideloadRegistryIdentity(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; registryIdentity: RegistryAppIdentity },
): AppInstallationState {
  const key = appInstallationKey(input.spaceId, input.appId);
  const existing = state.packagesByInstallationKey[key];
  if (!existing) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${input.appId} is not installed in Space ${input.spaceId}.`,
    );
  }
  if (existing.source !== "sideload") {
    throw new AppInstallationStateError(
      "source-mismatch",
      "Registry ownership recovery applies only to sideloaded Apps.",
    );
  }
  const registryIdentity = parseRegistryIdentity(input.registryIdentity, input.appId);
  return {
    ...state,
    packagesByInstallationKey: {
      ...state.packagesByInstallationKey,
      [key]: { ...existing, registryIdentity },
    },
  };
}

export function unregisterAppPackage(
  state: AppInstallationState,
  appId: string,
  spaceId: string,
): AppInstallationState {
  const key = appInstallationKey(spaceId, appId);
  if (!state.packagesByInstallationKey[key]) return state;
  const packagesByInstallationKey = { ...state.packagesByInstallationKey };
  delete packagesByInstallationKey[key];
  return { ...state, packagesByInstallationKey };
}

export function setSpaceAppEnabled(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; enabled: boolean },
): AppInstallationState {
  if (!getInstalledAppPackage(state, input.appId, input.spaceId)) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${input.appId} is not installed in this Space.`,
    );
  }
  const key = appInstallationKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key];
  const next: SpaceAppState = {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: input.enabled,
    permissions: current?.permissions ?? {},
    settings: current?.settings ?? {},
    settingMigrations: current?.settingMigrations ?? {},
    skills: current?.skills ?? {},
  };
  return { ...state, spaceStateByKey: { ...state.spaceStateByKey, [key]: next } };
}

export function setSpaceAppPermission(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; permission: string; grant: AppPermissionGrant },
): AppInstallationState {
  if (!getInstalledAppPackage(state, input.appId, input.spaceId)) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${input.appId} is not installed in this Space.`,
    );
  }
  const key = appInstallationKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key] ?? {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: false,
    permissions: {},
    settings: {},
    settingMigrations: {},
    skills: {},
  };
  const next: SpaceAppState = {
    ...current,
    permissions: { ...current.permissions, [input.permission]: input.grant },
  };
  return { ...state, spaceStateByKey: { ...state.spaceStateByKey, [key]: next } };
}

export function replaceSpaceAppPermissions(
  state: AppInstallationState,
  input: {
    appId: string;
    spaceId: string;
    permissions: Readonly<Record<string, AppPermissionGrant>>;
  },
): AppInstallationState {
  if (!getInstalledAppPackage(state, input.appId, input.spaceId)) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${input.appId} is not installed in this Space.`,
    );
  }
  for (const grant of Object.values(input.permissions)) {
    if (!isPermissionGrant(grant))
      throw new AppInstallationStateError("invalid-state", "Invalid App permission grant.");
  }
  const key = appInstallationKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key] ?? {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: false,
    permissions: {},
    settings: {},
    settingMigrations: {},
    skills: {},
  };
  return {
    ...state,
    spaceStateByKey: {
      ...state.spaceStateByKey,
      [key]: { ...current, permissions: { ...input.permissions } },
    },
  };
}

export function setSpaceAppSetting(
  state: AppInstallationState,
  input: {
    appId: string;
    spaceId: string;
    key: string;
    value: boolean | number | string;
    migrationId?: string;
  },
): AppInstallationState {
  if (!getInstalledAppPackage(state, input.appId, input.spaceId)) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${input.appId} is not installed in this Space.`,
    );
  }
  const key = appInstallationKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key] ?? {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: false,
    permissions: {},
    settings: {},
    settingMigrations: {},
    skills: {},
  };
  const settingMigrations = { ...current.settingMigrations };
  if (input.migrationId) settingMigrations[input.key] = input.migrationId;
  else delete settingMigrations[input.key];
  return {
    ...state,
    spaceStateByKey: {
      ...state.spaceStateByKey,
      [key]: {
        ...current,
        settings: { ...current.settings, [input.key]: input.value },
        settingMigrations,
      },
    },
  };
}

export function resetSpaceAppSetting(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; key: string },
): AppInstallationState {
  const key = appInstallationKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key];
  if (!current) return state;
  const settings = { ...current.settings };
  const settingMigrations = { ...current.settingMigrations };
  delete settings[input.key];
  delete settingMigrations[input.key];
  return {
    ...state,
    spaceStateByKey: {
      ...state.spaceStateByKey,
      [key]: { ...current, settings, settingMigrations },
    },
  };
}

export function setSpaceAppSettingMigration(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; key: string; migrationId?: string },
): AppInstallationState {
  const key = appInstallationKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key] ?? {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: false,
    permissions: {},
    settings: {},
    settingMigrations: {},
    skills: {},
  };
  const settingMigrations = { ...current.settingMigrations };
  if (input.migrationId) settingMigrations[input.key] = input.migrationId;
  else delete settingMigrations[input.key];
  return {
    ...state,
    spaceStateByKey: {
      ...state.spaceStateByKey,
      [key]: { ...current, settingMigrations },
    },
  };
}

export function setSpaceAppSkillEnabled(
  state: AppInstallationState,
  input: { appId: string; spaceId: string; path: string; enabled: boolean },
): AppInstallationState {
  const installed = getInstalledAppPackage(state, input.appId, input.spaceId);
  if (!installed) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${input.appId} is not installed in this Space.`,
    );
  }
  if (
    !(installed.manifest.contributions?.skills ?? []).some((skill) => skill.path === input.path)
  ) {
    throw new AppInstallationStateError(
      "invalid-state",
      `${input.path} is not declared by ${installed.name}.`,
    );
  }
  const key = appInstallationKey(input.spaceId, input.appId);
  const current = state.spaceStateByKey[key] ?? {
    appId: input.appId,
    spaceId: input.spaceId,
    enabled: false,
    permissions: {},
    settings: {},
    settingMigrations: {},
    skills: {},
  };
  return {
    ...state,
    spaceStateByKey: {
      ...state.spaceStateByKey,
      [key]: { ...current, skills: { ...current.skills, [input.path]: input.enabled } },
    },
  };
}

export function reconcileSpaceAppSkills(
  state: AppInstallationState,
  appId: string,
  spaceId: string,
): AppInstallationState {
  const installed = getInstalledAppPackage(state, appId, spaceId);
  if (!installed) {
    throw new AppInstallationStateError(
      "app-not-installed",
      `${appId} is not installed in Space ${spaceId}.`,
    );
  }
  const declared = new Set(
    (installed.manifest.contributions?.skills ?? []).map((skill) => skill.path),
  );
  const spaceStateByKey = Object.fromEntries(
    Object.entries(state.spaceStateByKey).map(([key, space]) => [
      key,
      space.appId === appId && space.spaceId === spaceId
        ? {
            ...space,
            skills: Object.fromEntries(
              Object.entries(space.skills).filter(([path]) => declared.has(path)),
            ),
          }
        : space,
    ]),
  );
  return { ...state, spaceStateByKey };
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

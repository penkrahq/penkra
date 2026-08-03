// FILE: appInstallationIpc.ts
// Purpose: Validates App-installation IPC requests and serializes trusted runtime state.
// Layer: Desktop IPC boundary

import type { DesktopAppInstallationSnapshot, DesktopAppSetting } from "@penkra/contracts";

import type { AppInstallationState, AppPermissionGrant } from "./appInstallationState";
import type { AppSettingSnapshot } from "./appSettings";

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid App installation request.");
  }
  return input as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid App installation request.");
  }
  return value;
}

export function toDesktopAppInstallationSnapshot(
  state: AppInstallationState,
  currentSpaceId?: string,
): DesktopAppInstallationSnapshot {
  return {
    installed: Object.entries(state.packagesByInstallationKey).map(([key, installed]) => ({
      id: installed.appId,
      spaceId: state.spaceStateByKey[key]!.spaceId,
      slug: installed.slug,
      name: installed.name,
      summary: installed.summary,
      version: installed.version,
      source: installed.source,
      installedAt: installed.installedAt,
      permissions: installed.manifest.permissions ?? [],
      skills: installed.manifest.contributions?.skills ?? [],
      handlers: installed.manifest.contributions?.handlers ?? [],
    })),
    spaces: Object.values(state.spaceStateByKey),
    ...(currentSpaceId === undefined ? {} : { currentSpaceId }),
  };
}

export function toDesktopAppSettings(
  snapshots: ReadonlyArray<AppSettingSnapshot>,
): ReadonlyArray<DesktopAppSetting> {
  return snapshots.map(({ declaration, configured, ...snapshot }) => ({
    ...declaration,
    ...snapshot,
    configured,
    ...(declaration.type === "string" ? { sensitive: declaration.sensitive === true } : {}),
  })) as ReadonlyArray<DesktopAppSetting>;
}

export function parseSetAppEnabledRequest(input: unknown): {
  appId: string;
  spaceId: string;
  enabled: boolean;
} {
  const record = requireRecord(input);
  if (typeof record.enabled !== "boolean") {
    throw new Error("Invalid App enablement request.");
  }
  return {
    appId: requireString(record, "appId"),
    spaceId: requireString(record, "spaceId"),
    enabled: record.enabled,
  };
}

export function parseInstallRegistryAppRequest(input: unknown): {
  slug: string;
  version: string;
  spaceId: string;
  permissions: Record<string, AppPermissionGrant>;
} {
  const record = requireRecord(input);
  const rawPermissions = requireRecord(record.permissions);
  const permissions: Record<string, AppPermissionGrant> = {};
  for (const [permission, grant] of Object.entries(rawPermissions)) {
    if (!permission || (grant !== "denied" && grant !== "granted")) {
      throw new Error("Invalid App installation permissions.");
    }
    permissions[permission] = grant;
  }
  return {
    slug: requireString(record, "slug"),
    version: requireString(record, "version"),
    spaceId: requireString(record, "spaceId"),
    permissions,
  };
}

export function parseUpdateRegistryAppRequest(input: unknown): {
  slug: string;
  version: string;
  spaceId: string;
  permissions: Record<string, AppPermissionGrant>;
} {
  const record = requireRecord(input);
  const permissions: Record<string, AppPermissionGrant> = {};
  for (const [permission, grant] of Object.entries(requireRecord(record.permissions))) {
    if (!permission || (grant !== "denied" && grant !== "granted")) {
      throw new Error("Invalid App update permissions.");
    }
    permissions[permission] = grant;
  }
  return {
    slug: requireString(record, "slug"),
    version: requireString(record, "version"),
    spaceId: requireString(record, "spaceId"),
    permissions,
  };
}

export const parseRollbackRegistryAppRequest = parseUpdateRegistryAppRequest;

export function parseSetAppPermissionRequest(input: unknown): {
  appId: string;
  spaceId: string;
  permission: string;
  grant: AppPermissionGrant;
} {
  const record = requireRecord(input);
  if (record.grant !== "denied" && record.grant !== "granted") {
    throw new Error("Invalid App permission grant.");
  }
  return {
    appId: requireString(record, "appId"),
    spaceId: requireString(record, "spaceId"),
    permission: requireString(record, "permission"),
    grant: record.grant,
  };
}

export function parseAppSettingTarget(input: unknown): { appId: string; spaceId: string } {
  const record = requireRecord(input);
  return {
    appId: requireString(record, "appId"),
    spaceId: requireString(record, "spaceId"),
  };
}

export function parseAppSettingKey(input: unknown): {
  appId: string;
  spaceId: string;
  key: string;
} {
  const record = requireRecord(input);
  return {
    ...parseAppSettingTarget(record),
    key: requireString(record, "key"),
  };
}

export function parseAppSettingValue(input: unknown): {
  appId: string;
  spaceId: string;
  key: string;
  value: boolean | number | string;
} {
  const record = requireRecord(input);
  const value = record.value;
  if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") {
    throw new Error("Invalid App setting value.");
  }
  return { ...parseAppSettingKey(record), value };
}

export function parseSetAppSkillEnabledRequest(input: unknown): {
  appId: string;
  spaceId: string;
  path: string;
  enabled: boolean;
} {
  const record = requireRecord(input);
  if (typeof record.enabled !== "boolean") throw new Error("Invalid App skill state.");
  return {
    appId: requireString(record, "appId"),
    spaceId: requireString(record, "spaceId"),
    path: requireString(record, "path"),
    enabled: record.enabled,
  };
}

export function parseUninstallAppRequest(input: unknown): {
  appId: string;
  spaceId: string;
  retainData: boolean;
} {
  const record = requireRecord(input);
  if (typeof record.retainData !== "boolean") throw new Error("Invalid uninstall request.");
  return {
    appId: requireString(record, "appId"),
    spaceId: requireString(record, "spaceId"),
    retainData: record.retainData,
  };
}

export function parseRemoveAppDataRequest(input: unknown): {
  appId: string;
  spaceId: string;
} {
  const record = requireRecord(input);
  return {
    appId: requireString(record, "appId"),
    spaceId: requireString(record, "spaceId"),
  };
}

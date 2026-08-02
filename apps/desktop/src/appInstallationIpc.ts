// FILE: appInstallationIpc.ts
// Purpose: Validates App-installation IPC requests and serializes trusted runtime state.
// Layer: Desktop IPC boundary

import type { DesktopAppInstallationSnapshot } from "@penkra/contracts";

import type { AppInstallationState, AppPermissionGrant } from "./appInstallationState";

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
    installed: Object.values(state.packagesByAppId).map((installed) => ({
      id: installed.appId,
      slug: installed.slug,
      name: installed.name,
      summary: installed.summary,
      version: installed.version,
      source: installed.source,
      installedAt: installed.installedAt,
      permissions: installed.manifest.permissions ?? [],
    })),
    spaces: Object.values(state.spaceStateByKey),
    ...(currentSpaceId === undefined ? {} : { currentSpaceId }),
  };
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
  permissionsBySpace: Record<string, Record<string, AppPermissionGrant>>;
} {
  const record = requireRecord(input);
  const rawBySpace = requireRecord(record.permissionsBySpace);
  const permissionsBySpace: Record<string, Record<string, AppPermissionGrant>> = {};
  for (const [spaceId, rawPermissions] of Object.entries(rawBySpace)) {
    if (!spaceId) throw new Error("Invalid App update Space.");
    const permissions: Record<string, AppPermissionGrant> = {};
    for (const [permission, grant] of Object.entries(requireRecord(rawPermissions))) {
      if (!permission || (grant !== "denied" && grant !== "granted")) {
        throw new Error("Invalid App update permissions.");
      }
      permissions[permission] = grant;
    }
    permissionsBySpace[spaceId] = permissions;
  }
  return {
    slug: requireString(record, "slug"),
    version: requireString(record, "version"),
    permissionsBySpace,
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

export function parseUninstallAppRequest(input: unknown): {
  appId: string;
  retainData: boolean;
} {
  const record = requireRecord(input);
  if (typeof record.retainData !== "boolean") throw new Error("Invalid uninstall request.");
  return { appId: requireString(record, "appId"), retainData: record.retainData };
}

export function parseRemoveAppDataRequest(input: unknown): {
  appId: string;
  spaceId?: string;
} {
  const record = requireRecord(input);
  const appId = requireString(record, "appId");
  if (record.spaceId === undefined) return { appId };
  return { appId, spaceId: requireString(record, "spaceId") };
}

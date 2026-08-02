// FILE: appPermissionQuery.ts
// Purpose: Resolves read-only permission status for one host-authenticated App renderer.
// Layer: Trusted desktop App permission boundary

import { isPenkraPermissionName, type AppPermissionStatus } from "@penkra/sdk";

import type { AppInstallationState } from "./appInstallationState";

export function queryAppPermission(
  state: AppInstallationState,
  identity: { appId: string; spaceId: string },
  input: unknown,
): AppPermissionStatus {
  if (typeof input !== "string" || !isPenkraPermissionName(input)) {
    throw new Error("App permission query has an unsupported permission name.");
  }
  const installed = state.packagesByAppId[identity.appId];
  if (!installed) throw new Error("The requesting App is not installed.");
  const declaration = installed.manifest.permissions?.find(
    (permission) => permission.name === input,
  );
  const space = state.spaceStateByKey[`${identity.spaceId}\u0000${identity.appId}`];
  return {
    name: input,
    declared: declaration !== undefined,
    required: declaration?.required ?? false,
    state: declaration ? (space?.permissions[input] ?? "denied") : "denied",
  };
}

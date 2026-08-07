// FILE: penkra-dev-instance.ts
// Purpose: Derives every stable local identity and path for a numbered Penkra Dev instance.

import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PENKRA_DEV_INSTANCE,
  penkraDevBundleId,
  penkraDevDisplayName,
  resolvePenkraDevInstance,
} from "@penkra/shared/desktopIdentity";

export const DEFAULT_INSTALLED_PENKRA_DEV_INSTANCES = [1, 2, 3] as const;

export interface PenkraDevInstanceDefinition {
  readonly instance: number;
  readonly displayName: string;
  readonly executableName: string;
  readonly launcherBundleId: string;
  readonly runtimeBundleId: string;
  readonly applicationPath: string;
  readonly developmentRoot: string;
}

export function resolvePenkraDevInstanceDefinition(
  value: number | string | undefined,
  homeDirectory = homedir(),
): PenkraDevInstanceDefinition {
  const instance =
    typeof value === "number"
      ? resolvePenkraDevInstance(String(value))
      : resolvePenkraDevInstance(value);
  const displayName = penkraDevDisplayName(instance);
  const runtimeBundleId = penkraDevBundleId(instance);
  const sharedDevelopmentRoot = join(homeDirectory, "Penkra_Dev");

  return {
    instance,
    displayName,
    executableName: displayName,
    launcherBundleId: `${runtimeBundleId}.launcher`,
    runtimeBundleId,
    applicationPath: join("/Applications", `${displayName}.app`),
    developmentRoot:
      instance === DEFAULT_PENKRA_DEV_INSTANCE
        ? sharedDevelopmentRoot
        : join(sharedDevelopmentRoot, ".instances", String(instance)),
    // Keep a generous deterministic block between embedded desktop servers.
    // Slot 1 preserves today's ports; every later slot is stable and collision-free.
  };
}

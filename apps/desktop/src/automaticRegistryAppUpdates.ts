// FILE: automaticRegistryAppUpdates.ts
// Purpose: Reconciles installed registry Apps with newer compatible releases that need no new authority.
// Layer: Trusted Electron main process

import { permissionsRequiringUpdateReview } from "@penkra/sdk";
import { gt, rcompare, satisfies } from "semver";

import type { DesktopAppRuntime } from "./desktopAppRuntime";
import { appInstallationKey, type AppPermissionGrant } from "./appInstallationState";
import type { AppRegistryClient } from "./appRegistryClient";
import { updateRegistryApp } from "./registryAppInstaller";

export interface AutomaticRegistryAppUpdateReport {
  checked: number;
  updated: ReadonlyArray<{
    appId: string;
    spaceId: string;
    fromVersion: string;
    toVersion: string;
  }>;
  reviewRequired: ReadonlyArray<{
    appId: string;
    spaceId: string;
    installedVersion: string;
    availableVersion: string;
    permissions: ReadonlyArray<string>;
  }>;
  failures: ReadonlyArray<{
    appId: string;
    spaceId: string;
    installedVersion: string;
    availableVersion?: string;
    retryable: boolean;
    error: Error;
  }>;
}

type Registry = Pick<AppRegistryClient, "get" | "downloadVerifiedRelease" | "getSecurityPolicy">;

type Runtime = Pick<DesktopAppRuntime, "packages" | "installations">;

export async function reconcileAutomaticRegistryAppUpdates(input: {
  runtime: Runtime;
  registry: Registry;
  hostVersion: string;
  spaceIds: ReadonlyArray<string>;
}): Promise<AutomaticRegistryAppUpdateReport> {
  const report: {
    checked: number;
    updated: Array<AutomaticRegistryAppUpdateReport["updated"][number]>;
    reviewRequired: Array<AutomaticRegistryAppUpdateReport["reviewRequired"][number]>;
    failures: Array<AutomaticRegistryAppUpdateReport["failures"][number]>;
  } = { checked: 0, updated: [], reviewRequired: [], failures: [] };
  const selectedSpaces = new Set(input.spaceIds);
  const installations = Object.entries(
    input.runtime.installations.snapshot().packagesByInstallationKey,
  ).filter(([key, installed]) => {
    const spaceId = key.slice(0, key.indexOf("\u0000"));
    return selectedSpaces.has(spaceId) && installed.source === "registry";
  });

  for (const [key, initial] of installations) {
    const spaceId = key.slice(0, key.indexOf("\u0000"));
    report.checked += 1;
    let availableVersion: string | undefined;
    try {
      const current = input.runtime.installations.snapshot().packagesByInstallationKey[key];
      if (!current || current.source !== "registry") continue;
      const listing = await input.registry.get({ slug: current.slug });
      if (listing.identifier !== current.appId) {
        throw new Error(
          `Registry slug ${current.slug} resolved to unexpected identity ${listing.identifier}.`,
        );
      }
      const candidate = [...listing.versions]
        .filter(
          (version) =>
            gt(version.version, current.version) &&
            satisfies(input.hostVersion, version.compatibilityRange, { includePrerelease: true }),
        )
        .sort((left, right) => rcompare(left.version, right.version))[0];
      if (!candidate) continue;
      availableVersion = candidate.version;
      const nextPermissions = candidate.permissions.map((permission) => ({
        name: permission.permission,
        required: permission.required,
        reason: permission.rationale,
        ...(permission.audience ? { audience: permission.audience } : {}),
      }));
      const reviewPermissions = permissionsRequiringUpdateReview(
        current.manifest.permissions ?? [],
        nextPermissions,
      );
      if (reviewPermissions.length > 0) {
        report.reviewRequired.push({
          appId: current.appId,
          spaceId,
          installedVersion: current.version,
          availableVersion: candidate.version,
          permissions: reviewPermissions,
        });
        continue;
      }
      const space =
        input.runtime.installations.snapshot().spaceStateByKey[
          appInstallationKey(spaceId, current.appId)
        ];
      if (!space) throw new Error(`${current.appId} has no state in Space ${spaceId}.`);
      const declared = new Set(candidate.permissions.map((permission) => permission.permission));
      const permissions = Object.fromEntries(
        Object.entries(space.permissions).filter(([permission]) => declared.has(permission)),
      ) as Record<string, AppPermissionGrant>;
      await updateRegistryApp({
        request: {
          slug: current.slug,
          version: candidate.version,
          spaceId,
          permissions,
        },
        hostVersion: input.hostVersion,
        registry: input.registry,
        packages: input.runtime.packages,
        installations: input.runtime.installations,
      });
      report.updated.push({
        appId: current.appId,
        spaceId,
        fromVersion: current.version,
        toVersion: candidate.version,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      report.failures.push({
        appId: initial.appId,
        spaceId,
        installedVersion: initial.version,
        ...(availableVersion === undefined ? {} : { availableVersion }),
        retryable: isTransientAutomaticUpdateError(failure),
        error: failure,
      });
    }
  }
  return report;
}

export function isTransientAutomaticUpdateError(error: Error): boolean {
  return (
    error instanceof TypeError ||
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /\b(?:network|fetch|offline|timed? out|timeout|temporarily unavailable)\b/i.test(
      error.message,
    ) ||
    /\bHTTP 5\d\d\b/i.test(error.message)
  );
}

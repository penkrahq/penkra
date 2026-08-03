// FILE: firstPartyAppsBootstrap.ts
// Purpose: Resolves and installs the bundled first-party Apps package through normal ingestion.
// Layer: Desktop App bootstrap

import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopAppRuntime } from "./desktopAppRuntime";
import { getInstalledAppPackage } from "./appInstallationState";

export const FIRST_PARTY_APPS_ID = "com.penkra.apps";
export const PENKRA_APPS_PACKAGE_PATH_ENV = "PENKRA_APPS_PACKAGE_PATH";
export const FIRST_PARTY_APP_PACKAGES = [
  { directory: "apps", appId: "com.penkra.apps" },
  { directory: "explorer", appId: "com.penkra.explorer" },
  { directory: "browser", appId: "com.penkra.browser" },
] as const;
const FIRST_PARTY_PERMISSION_GRANTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "com.penkra.browser": ["browser-session"],
};

export function resolveFirstPartyAppsPackagePath(input: {
  configuredPath?: string;
  resourcesPath: string;
  desktopBundleDirectory: string;
  packaged: boolean;
}): string | null {
  const configured = input.configuredPath?.trim();
  const candidates = [
    ...(configured ? [Path.resolve(configured)] : []),
    ...(input.packaged ? [Path.join(input.resourcesPath, "penkra-apps", "apps")] : []),
    Path.resolve(input.desktopBundleDirectory, "../../../..", "penkra-apps", "apps"),
  ];
  return (
    candidates.find((candidate) => FS.existsSync(Path.join(candidate, "penkra-app.json"))) ?? null
  );
}

export function resolveFirstPartyAppPackagePaths(input: {
  configuredPath?: string;
  resourcesPath: string;
  desktopBundleDirectory: string;
  packaged: boolean;
}): ReadonlyArray<{ sourcePath: string; expectedAppId: string }> {
  const appsPath = resolveFirstPartyAppsPackagePath(input);
  if (!appsPath) return [];
  const root = Path.dirname(appsPath);
  return FIRST_PARTY_APP_PACKAGES.flatMap(({ directory, appId }) => {
    const sourcePath = directory === "apps" ? appsPath : Path.join(root, directory);
    return FS.existsSync(Path.join(sourcePath, "penkra-app.json"))
      ? [{ sourcePath, expectedAppId: appId }]
      : [];
  });
}

export async function bootstrapFirstPartyAppsPackage(
  runtime: Pick<DesktopAppRuntime, "packages" | "installations">,
  sourcePath: string,
  spaceIds: ReadonlyArray<string>,
  expectedAppId = FIRST_PARTY_APPS_ID,
): Promise<"installed" | "current" | "updated"> {
  const verified = await runtime.packages.ingestDirectory({
    sourcePath,
    source: "registry",
  });
  if (verified.manifest.id !== expectedAppId) {
    throw new Error(`Bundled App package must use ${expectedAppId}.`);
  }
  let result: "installed" | "current" | "updated" = "current";
  for (const spaceId of new Set(spaceIds)) {
    const current = runtime.installations.snapshot();
    const existing = getInstalledAppPackage(current, expectedAppId, spaceId);
    if (!existing) {
      // Retained Space state without a package is the durable uninstall marker. Do not
      // silently reinstall a bundled App the user explicitly removed.
      if (current.spaceStateByKey[`${spaceId}\u0000${expectedAppId}`]) continue;
      await runtime.installations.install(verified, spaceId);
      for (const permission of FIRST_PARTY_PERMISSION_GRANTS[expectedAppId] ?? []) {
        await runtime.installations.setPermission({
          appId: expectedAppId,
          spaceId,
          permission,
          grant: "granted",
        });
      }
      await runtime.installations.setEnabled({
        appId: expectedAppId,
        spaceId,
        enabled: true,
      });
      result = "installed";
      continue;
    }
    if (existing.sha256 === verified.sha256) continue;
    const permissions = {
      ...(current.spaceStateByKey[`${spaceId}\u0000${expectedAppId}`]?.permissions ?? {}),
      ...Object.fromEntries(
        (FIRST_PARTY_PERMISSION_GRANTS[expectedAppId] ?? []).map((permission) => [
          permission,
          "granted" as const,
        ]),
      ),
    };
    await runtime.installations.updateForSpace({
      package: { ...verified, source: "registry" },
      spaceId,
      permissions,
    });
    result = "updated";
  }
  return result;
}

export async function bootstrapFirstPartyAppPackages(
  runtime: Pick<DesktopAppRuntime, "packages" | "installations">,
  packages: ReadonlyArray<{ sourcePath: string; expectedAppId: string }>,
  spaceIds: ReadonlyArray<string>,
): Promise<void> {
  for (const bundledPackage of packages) {
    await bootstrapFirstPartyAppsPackage(
      runtime,
      bundledPackage.sourcePath,
      spaceIds,
      bundledPackage.expectedAppId,
    );
  }
}

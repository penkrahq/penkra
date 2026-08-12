// FILE: defaultRegistryAppsBootstrap.ts
// Purpose: Installs Penkra's default Apps into new Spaces through the ordinary registry path.
// Layer: Desktop App bootstrap

import type { DesktopAppRuntime } from "./desktopAppRuntime";
import { getInstalledAppPackage } from "./appInstallationState";
import type { AppRegistryClient } from "./appRegistryClient";
import { installRegistryApp } from "./registryAppInstaller";
import { DEFAULT_REGISTRY_APPS } from "./appDistributionPolicy";

/**
 * Installs each default through the same signed-release downloader, policy checks,
 * immutable package ingestor, and installation service used by the Apps App.
 *
 * A retained Space record is an explicit uninstall marker for optional defaults.
 * Required Apps is reconciled from the desktop's pinned embedded registry package
 * before this best-effort remote bootstrap runs.
 */
export async function bootstrapDefaultRegistryApps(input: {
  runtime: Pick<DesktopAppRuntime, "packages" | "installations">;
  registry: Pick<
    AppRegistryClient,
    "get" | "downloadVerifiedRelease" | "getSecurityPolicy" | "recordSuccessfulInstallDurably"
  >;
  hostVersion: string;
  spaceIds: ReadonlyArray<string>;
}): Promise<void> {
  for (const spaceId of new Set(input.spaceIds)) {
    for (const defaultApp of DEFAULT_REGISTRY_APPS) {
      const snapshot = input.runtime.installations.snapshot();
      if (getInstalledAppPackage(snapshot, defaultApp.appId, spaceId)) continue;

      const retained = snapshot.spaceStateByKey[`${spaceId}\u0000${defaultApp.appId}`];
      if (retained) continue;

      const listing = await input.registry.get({ slug: defaultApp.slug });
      if (listing.identifier !== defaultApp.appId) {
        throw new Error(
          `Default App ${defaultApp.slug} resolved to unexpected identity ${listing.identifier}.`,
        );
      }
      await installRegistryApp({
        request: {
          slug: defaultApp.slug,
          version: listing.latestVersion,
          spaceId,
          permissions: defaultApp.permissions,
        },
        hostVersion: input.hostVersion,
        registry: input.registry,
        packages: input.runtime.packages,
        installations: input.runtime.installations,
      });
    }
  }
}

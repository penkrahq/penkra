import { describe, expect, it } from "vitest";

import {
  AppInstallationStateError,
  createEmptyAppInstallationState,
  parseAppInstallationState,
  registerVerifiedAppPackage,
  removeRetainedAppState,
  replaceVerifiedRegistryAppPackage,
  setSpaceAppEnabled,
  setSpaceAppPermission,
  unregisterAppPackage,
  type VerifiedAppPackageInput,
} from "./appInstallationState";

const manifest = {
  manifestVersion: 1,
  id: "com.penkra.apps",
  slug: "apps",
  name: "Apps",
  summary: "Discover and manage Penkra Apps.",
  version: "0.1.0",
  compatibility: { penkra: ">=0.8.0" },
  icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
  entrypoints: { app: "app.html", operations: "operations.html" },
} as const;

function verifiedPackage(
  patch: Partial<VerifiedAppPackageInput> = {},
): VerifiedAppPackageInput {
  return {
    manifest,
    source: "registry",
    packagePath: "/profile/apps/com.penkra.apps/0.1.0",
    sha256: "a".repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
    ...patch,
  };
}

describe("App installation state", () => {
  it("installs one profile package and scopes enablement and permissions by Space", () => {
    const installed = registerVerifiedAppPackage(
      createEmptyAppInstallationState(),
      verifiedPackage(),
    );
    const personal = setSpaceAppPermission(
      setSpaceAppEnabled(installed, {
        appId: manifest.id,
        spaceId: "personal",
        enabled: true,
      }),
      {
        appId: manifest.id,
        spaceId: "personal",
        permission: "network-fetch",
        grant: "granted",
      },
    );
    const work = setSpaceAppEnabled(personal, {
      appId: manifest.id,
      spaceId: "work",
      enabled: false,
    });

    expect(Object.keys(work.packagesByAppId)).toEqual([manifest.id]);
    expect(Object.values(work.spaceStateByKey)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spaceId: "personal", enabled: true }),
        expect.objectContaining({ spaceId: "work", enabled: false }),
      ]),
    );
  });

  it("does not let a sideload override an installed App or claim its slug", () => {
    const installed = registerVerifiedAppPackage(
      createEmptyAppInstallationState(),
      verifiedPackage(),
    );
    expect(() =>
      registerVerifiedAppPackage(installed, verifiedPackage({ source: "sideload" })),
    ).toThrowError(
      expect.objectContaining<AppInstallationStateError>({ code: "app-already-installed" }),
    );

    expect(() =>
      registerVerifiedAppPackage(
        installed,
        verifiedPackage({
          source: "sideload",
          manifest: { ...manifest, id: "com.acme.apps" },
        }),
      ),
    ).toThrowError(expect.objectContaining<AppInstallationStateError>({ code: "slug-collision" }));
  });

  it("updates only verified registry installations with stable identity", () => {
    const installed = registerVerifiedAppPackage(
      createEmptyAppInstallationState(),
      verifiedPackage(),
    );
    const updated = replaceVerifiedRegistryAppPackage(
      installed,
      verifiedPackage({
        manifest: { ...manifest, version: "0.2.0" },
        packagePath: "/profile/apps/com.penkra.apps/0.2.0",
        sha256: "b".repeat(64),
      }),
    );
    expect(updated.packagesByAppId[manifest.id]?.version).toBe("0.2.0");
  });

  it("retains Space state on uninstall until explicitly erased", () => {
    const installed = registerVerifiedAppPackage(
      createEmptyAppInstallationState(),
      verifiedPackage(),
    );
    const enabled = setSpaceAppEnabled(installed, {
      appId: manifest.id,
      spaceId: "personal",
      enabled: true,
    });
    const uninstalled = unregisterAppPackage(enabled, manifest.id);
    expect(uninstalled.packagesByAppId).toEqual({});
    expect(Object.values(uninstalled.spaceStateByKey)).toHaveLength(1);
    expect(removeRetainedAppState(uninstalled, { appId: manifest.id }).spaceStateByKey).toEqual({});
  });

  it("rejects corrupt persisted state instead of silently resetting it", () => {
    expect(() =>
      parseAppInstallationState({
        schemaVersion: 1,
        packagesByAppId: {
          [manifest.id]: {
            appId: manifest.id,
            slug: manifest.slug,
            name: manifest.name,
            summary: manifest.summary,
            version: manifest.version,
            source: "registry",
            packagePath: "/tmp/package",
            sha256: "not-a-digest",
            installedAt: "2026-08-01T00:00:00.000Z",
          },
        },
        spaceStateByKey: {},
      }),
    ).toThrowError(expect.objectContaining<AppInstallationStateError>({ code: "invalid-state" }));
  });
});

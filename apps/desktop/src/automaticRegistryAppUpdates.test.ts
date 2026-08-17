import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyAppInstallationState } from "./appInstallationState";
import {
  isTransientAutomaticUpdateError,
  reconcileAutomaticRegistryAppUpdates,
} from "./automaticRegistryAppUpdates";
import { updateRegistryApp } from "./registryAppInstaller";

vi.mock("./registryAppInstaller", () => ({ updateRegistryApp: vi.fn(async () => ({})) }));

function installedState(
  permissions: ReadonlyArray<{ name: string; required: boolean; reason: string }> = [],
) {
  const empty = createEmptyAppInstallationState();
  return {
    ...empty,
    packagesByInstallationKey: {
      "personal\0com.example.notes": {
        appId: "com.example.notes",
        slug: "notes",
        name: "Notes",
        summary: "Keep notes.",
        version: "1.0.0",
        source: "registry" as const,
        packagePath: "/apps/notes/1.0.0",
        sha256: "a".repeat(64),
        installedAt: "2026-08-01T00:00:00.000Z",
        manifest: {
          manifestVersion: 2 as const,
          id: "com.example.notes",
          slug: "notes",
          name: "Notes",
          summary: "Keep notes.",
          version: "1.0.0",
          compatibility: { penkra: ">=0.8.0" },
          icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
          entrypoints: { app: "app.html" },
          permissions,
        },
      },
    },
    spaceStateByKey: {
      "personal\0com.example.notes": {
        appId: "com.example.notes",
        spaceId: "personal",
        enabled: true,
        permissions: Object.fromEntries(
          permissions.map((permission) => [permission.name, "granted"]),
        ),
        settings: {},
        settingMigrations: {},
        skills: {},
      },
    },
  };
}

function listing(
  permissions: ReadonlyArray<{
    permission: string;
    required: boolean;
    rationale: string;
  }> = [],
) {
  return {
    identifier: "com.example.notes",
    slug: "notes",
    versions: [{ version: "2.0.0", compatibilityRange: ">=0.8.0", permissions }],
  };
}

describe("automatic registry App updates", () => {
  beforeEach(() => vi.mocked(updateRegistryApp).mockClear());

  it("installs a newer compatible release when authority does not expand", async () => {
    const state = installedState([
      { name: "network-fetch", required: false, reason: "Sync notes." },
    ]);
    const report = await reconcileAutomaticRegistryAppUpdates({
      runtime: {
        packages: {},
        installations: { snapshot: () => state },
      } as never,
      registry: {
        get: vi.fn(async () =>
          listing([{ permission: "network-fetch", required: false, rationale: "Sync notes." }]),
        ),
      } as never,
      hostVersion: "0.8.7",
      spaceIds: ["personal"],
    });

    expect(report.updated).toEqual([
      {
        appId: "com.example.notes",
        spaceId: "personal",
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
      },
    ]);
    expect(report.reviewRequired).toEqual([]);
    expect(updateRegistryApp).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          slug: "notes",
          version: "2.0.0",
          permissions: { "network-fetch": "granted" },
        }),
      }),
    );
  });

  it("leaves the working version active when a release adds permission authority", async () => {
    const state = installedState();
    const report = await reconcileAutomaticRegistryAppUpdates({
      runtime: {
        packages: {},
        installations: { snapshot: () => state },
      } as never,
      registry: {
        get: vi.fn(async () =>
          listing([{ permission: "network-fetch", required: false, rationale: "Sync notes." }]),
        ),
      } as never,
      hostVersion: "0.8.7",
      spaceIds: ["personal"],
    });

    expect(report.updated).toEqual([]);
    expect(report.reviewRequired).toEqual([
      expect.objectContaining({
        appId: "com.example.notes",
        availableVersion: "2.0.0",
        permissions: ["network-fetch"],
      }),
    ]);
    expect(updateRegistryApp).not.toHaveBeenCalled();
  });

  it("skips an incompatible release without disturbing the installation", async () => {
    const state = installedState();
    const report = await reconcileAutomaticRegistryAppUpdates({
      runtime: {
        packages: {},
        installations: { snapshot: () => state },
      } as never,
      registry: {
        get: vi.fn(async () => ({
          ...listing(),
          versions: [{ version: "2.0.0", compatibilityRange: ">=9.0.0", permissions: [] }],
        })),
      } as never,
      hostVersion: "0.8.7",
      spaceIds: ["personal"],
    });

    expect(report.updated).toEqual([]);
    expect(report.reviewRequired).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(updateRegistryApp).not.toHaveBeenCalled();
  });

  it("selects the newest compatible release when the catalog latest requires a newer host", async () => {
    const state = installedState();
    const report = await reconcileAutomaticRegistryAppUpdates({
      runtime: {
        packages: {},
        installations: { snapshot: () => state },
      } as never,
      registry: {
        get: vi.fn(async () => ({
          ...listing(),
          versions: [
            { version: "3.0.0", compatibilityRange: ">=9.0.0", permissions: [] },
            { version: "2.1.0", compatibilityRange: ">=0.8.0", permissions: [] },
            { version: "2.0.0", compatibilityRange: ">=0.8.0", permissions: [] },
          ],
        })),
      } as never,
      hostVersion: "0.8.7",
      spaceIds: ["personal"],
    });

    expect(report.updated[0]?.toVersion).toBe("2.1.0");
    expect(updateRegistryApp).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ version: "2.1.0" }) }),
    );
  });

  it("reports a failed automatic update without replacing the working version", async () => {
    vi.mocked(updateRegistryApp).mockRejectedValueOnce(new Error("registry unavailable"));
    const state = installedState();
    const report = await reconcileAutomaticRegistryAppUpdates({
      runtime: {
        packages: {},
        installations: { snapshot: () => state },
      } as never,
      registry: { get: vi.fn(async () => listing()) } as never,
      hostVersion: "0.8.7",
      spaceIds: ["personal"],
    });

    expect(report.updated).toEqual([]);
    expect(report.failures).toEqual([
      expect.objectContaining({
        appId: "com.example.notes",
        availableVersion: "2.0.0",
        retryable: false,
        error: expect.any(Error),
      }),
    ]);
  });

  it("retries only transient network and service failures on the short schedule", () => {
    expect(isTransientAutomaticUpdateError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientAutomaticUpdateError(new Error("The registry returned HTTP 503."))).toBe(
      true,
    );
    expect(isTransientAutomaticUpdateError(new Error("Package signature is invalid."))).toBe(false);
  });
});

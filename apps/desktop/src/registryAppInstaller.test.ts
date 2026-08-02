import { describe, expect, it, vi } from "vitest";

import { createEmptyAppInstallationState } from "./appInstallationState";
import { installRegistryApp, rollbackRegistryApp, updateRegistryApp } from "./registryAppInstaller";

const version = {
  id: "00000000-0000-4000-8000-000000000403",
  version: "1.0.0",
  packageDigest: "a".repeat(64),
  compatibilityRange: ">=0.8.0 <2.0.0",
  publishedAt: "2026-08-01T00:00:00.000Z",
  readmeArtifactId: "00000000-0000-4000-8000-000000000404",
  instructionsArtifactId: "00000000-0000-4000-8000-000000000405",
  publisherSignatureArtifactId: "00000000-0000-4000-8000-000000000406",
  registrySignatureArtifactId: "00000000-0000-4000-8000-000000000407",
  validationReportArtifactId: "00000000-0000-4000-8000-000000000408",
  permissions: [{ permission: "network-fetch", required: true, rationale: "Sync" }],
};
const app = {
  id: "00000000-0000-4000-8000-000000000401",
  identifier: "com.example.canvas",
  slug: "canvas",
  displayName: "Canvas",
  summary: "Draw together",
  publisher: { slug: "example", displayName: "Example", domain: "example.com", verified: true },
  latestVersion: "1.0.0",
  iconAssetId: "00000000-0000-4000-8000-000000000402",
  installCount: 0,
  rating: null,
  ratingCount: 0,
  screenshots: [],
  versions: [version],
};

describe("registry App installer", () => {
  it("passes only a verified, compatible package and reviewed grants to installation", async () => {
    const installForSpace = vi.fn().mockResolvedValue(createEmptyAppInstallationState());
    const recordSuccessfulInstallDurably = vi.fn().mockResolvedValue(undefined);
    const getSecurityPolicy = vi.fn().mockResolvedValue({
      registry: "penkra.com",
      generatedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      revocations: [],
      keyId: "a".repeat(16),
    });
    const packageBytes = Uint8Array.from([1, 2, 3]);
    const ingestRegistryArchive = vi.fn().mockResolvedValue({
      source: "registry",
      packagePath: "/profile/apps/canvas",
      sha256: "b".repeat(64),
      installedAt: "2026-08-01T00:00:00.000Z",
      manifest: {
        manifestVersion: 1,
        id: app.identifier,
        slug: app.slug,
        name: app.displayName,
        summary: app.summary,
        version: version.version,
        compatibility: { penkra: version.compatibilityRange },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.js" },
        permissions: [{ name: "network-fetch", required: true, reason: "Sync" }],
      },
    });

    await installRegistryApp({
      request: { slug: "canvas", version: "1.0.0", spaceId: "space", permissions: { "network-fetch": "granted" } },
      hostVersion: "0.8.7",
      registry: {
        get: vi.fn().mockResolvedValue(app),
        downloadVerifiedRelease: vi.fn().mockResolvedValue({
          packageBytes,
          release: {
            appId: app.id,
            versionId: version.id,
            publisher: { id: "00000000-0000-4000-8000-000000000409" },
            packageDigest: version.packageDigest,
            keyId: "a".repeat(16),
            publishedAt: version.publishedAt,
          },
        }),
        getSecurityPolicy,
        recordSuccessfulInstallDurably,
      },
      packages: { ingestRegistryArchive },
      installations: { installForSpace },
    });

    expect(ingestRegistryArchive).toHaveBeenCalledWith({ packageBytes, expectedArchiveDigest: version.packageDigest });
    expect(installForSpace).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: "space",
      permissions: { "network-fetch": "granted" },
    }));
    expect(recordSuccessfulInstallDurably).toHaveBeenCalledWith({ appId: app.id, versionId: version.id });
  });

  it("rejects incompatible releases and missing required grants before download", async () => {
    const downloadVerifiedRelease = vi.fn();
    await expect(installRegistryApp({
      request: { slug: "canvas", version: "1.0.0", spaceId: "space", permissions: {} },
      hostVersion: "0.8.7",
      registry: {
        get: vi.fn().mockResolvedValue(app),
        downloadVerifiedRelease,
        getSecurityPolicy: vi.fn(),
        recordSuccessfulInstallDurably: vi.fn(),
      },
      packages: { ingestRegistryArchive: vi.fn() },
      installations: { installForSpace: vi.fn() },
    })).rejects.toThrow("must be granted");
    expect(downloadVerifiedRelease).not.toHaveBeenCalled();
  });

  it("passes a newer verified release to the rollback-capable update owner", async () => {
    const updatedVersion = { ...version, version: "2.0.0" };
    const updatedApp = { ...app, latestVersion: "2.0.0", versions: [updatedVersion] };
    const updateForSpaces = vi.fn().mockResolvedValue(createEmptyAppInstallationState());
    const packageBytes = Uint8Array.from([4, 5, 6]);
    const installedPackage = {
      source: "registry" as const,
      packagePath: "/profile/apps/canvas/2.0.0",
      sha256: "b".repeat(64),
      installedAt: "2026-08-02T00:00:00.000Z",
      manifest: {
        manifestVersion: 1 as const,
        id: app.identifier,
        slug: app.slug,
        name: app.displayName,
        summary: app.summary,
        version: "2.0.0",
        compatibility: { penkra: version.compatibilityRange },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.js" },
        permissions: [{ name: "network-fetch", required: true, reason: "Sync" }],
      },
    };
    await updateRegistryApp({
      request: {
        slug: "canvas",
        version: "2.0.0",
        permissionsBySpace: { personal: { "network-fetch": "granted" } },
      },
      hostVersion: "0.8.7",
      registry: {
        get: vi.fn().mockResolvedValue(updatedApp),
        downloadVerifiedRelease: vi.fn().mockResolvedValue({
          packageBytes,
          release: {
            appId: app.id,
            versionId: updatedVersion.id,
            publisher: { id: "00000000-0000-4000-8000-000000000409" },
            packageDigest: updatedVersion.packageDigest,
            keyId: "a".repeat(16),
            publishedAt: updatedVersion.publishedAt,
          },
        }),
        getSecurityPolicy: vi.fn().mockResolvedValue({
          registry: "penkra.com",
          generatedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
          revocations: [],
          keyId: "a".repeat(16),
        }),
      },
      packages: { ingestRegistryArchive: vi.fn().mockResolvedValue(installedPackage) },
      installations: {
        snapshot: () => ({
          ...createEmptyAppInstallationState(),
          packagesByAppId: { [app.identifier]: { ...installedPackage, appId: app.identifier, slug: app.slug, name: app.displayName, summary: app.summary, version: "1.0.0", manifest: { ...installedPackage.manifest, version: "1.0.0" } } },
        }),
        updateForSpaces,
      },
    });
    expect(updateForSpaces).toHaveBeenCalledWith(expect.objectContaining({
      permissionsBySpace: { personal: { "network-fetch": "granted" } },
      package: expect.objectContaining({ registryRelease: expect.objectContaining({ appId: app.id }) }),
    }));
  });

  it("re-verifies an older immutable release before handing rollback to the durable update owner", async () => {
    const currentVersion = { ...version, id: "00000000-0000-4000-8000-000000000413", version: "2.0.0" };
    const rollbackApp = { ...app, latestVersion: "2.0.0", versions: [version, currentVersion] };
    const updateForSpaces = vi.fn().mockResolvedValue(createEmptyAppInstallationState());
    const downloadVerifiedRelease = vi.fn().mockResolvedValue({
      packageBytes: Uint8Array.from([7, 8, 9]),
      release: {
        appId: app.id,
        versionId: version.id,
        publisher: { id: "00000000-0000-4000-8000-000000000409" },
        packageDigest: version.packageDigest,
        keyId: "a".repeat(16),
        publishedAt: version.publishedAt,
      },
    });
    const rolledBackPackage = {
      source: "registry" as const,
      packagePath: "/profile/apps/canvas/1.0.0",
      sha256: "b".repeat(64),
      installedAt: "2026-08-02T00:00:00.000Z",
      manifest: {
        manifestVersion: 1 as const,
        id: app.identifier,
        slug: app.slug,
        name: app.displayName,
        summary: app.summary,
        version: "1.0.0",
        compatibility: { penkra: version.compatibilityRange },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.js" },
        permissions: [{ name: "network-fetch", required: true, reason: "Sync" }],
      },
    };

    await rollbackRegistryApp({
      request: {
        slug: "canvas",
        version: "1.0.0",
        permissionsBySpace: { personal: { "network-fetch": "granted" } },
      },
      hostVersion: "0.8.7",
      registry: {
        get: vi.fn().mockResolvedValue(rollbackApp),
        downloadVerifiedRelease,
        getSecurityPolicy: vi.fn().mockResolvedValue({
          registry: "penkra.com",
          generatedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-09-01T00:00:00.000Z",
          revocations: [],
          keyId: "a".repeat(16),
        }),
      },
      packages: { ingestRegistryArchive: vi.fn().mockResolvedValue(rolledBackPackage) },
      installations: {
        snapshot: () => ({
          ...createEmptyAppInstallationState(),
          packagesByAppId: {
            [app.identifier]: {
              ...rolledBackPackage,
              appId: app.identifier,
              slug: app.slug,
              name: app.displayName,
              summary: app.summary,
              version: "2.0.0",
              manifest: { ...rolledBackPackage.manifest, version: "2.0.0" },
            },
          },
        }),
        updateForSpaces,
      },
    });

    expect(downloadVerifiedRelease).toHaveBeenCalledWith({ app: rollbackApp, version });
    expect(updateForSpaces).toHaveBeenCalledWith(expect.objectContaining({
      permissionsBySpace: { personal: { "network-fetch": "granted" } },
      package: expect.objectContaining({ manifest: expect.objectContaining({ version: "1.0.0" }) }),
    }));
  });

  it("rejects a rollback that does not move to an older version before download", async () => {
    const downloadVerifiedRelease = vi.fn();
    await expect(rollbackRegistryApp({
      request: { slug: "canvas", version: "1.0.0", permissionsBySpace: {} },
      hostVersion: "0.8.7",
      registry: {
        get: vi.fn().mockResolvedValue(app),
        downloadVerifiedRelease,
        getSecurityPolicy: vi.fn(),
      },
      packages: { ingestRegistryArchive: vi.fn() },
      installations: {
        snapshot: () => ({
          ...createEmptyAppInstallationState(),
          packagesByAppId: {
            [app.identifier]: {
              appId: app.identifier,
              slug: app.slug,
              name: app.displayName,
              summary: app.summary,
              version: "1.0.0",
              source: "registry",
              packagePath: "/profile/apps/canvas/1.0.0",
              sha256: "b".repeat(64),
              installedAt: "2026-08-01T00:00:00.000Z",
              manifest: {
                manifestVersion: 1,
                id: app.identifier,
                slug: app.slug,
                name: app.displayName,
                summary: app.summary,
                version: "1.0.0",
                compatibility: { penkra: version.compatibilityRange },
                icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
                entrypoints: { app: "app.js" },
                permissions: [{ name: "network-fetch", required: true, reason: "Sync" }],
              },
            },
          },
        }),
        updateForSpaces: vi.fn(),
      },
    })).rejects.toThrow("older than 1.0.0");
    expect(downloadVerifiedRelease).not.toHaveBeenCalled();
  });
});

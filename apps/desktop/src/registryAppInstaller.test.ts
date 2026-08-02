import { describe, expect, it, vi } from "vitest";

import { createEmptyAppInstallationState } from "./appInstallationState";
import { installRegistryApp } from "./registryAppInstaller";

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
    const recordSuccessfulInstall = vi.fn().mockResolvedValue(undefined);
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
        recordSuccessfulInstall,
      },
      packages: { ingestRegistryArchive },
      installations: { installForSpace },
    });

    expect(ingestRegistryArchive).toHaveBeenCalledWith({ packageBytes, expectedArchiveDigest: version.packageDigest });
    expect(installForSpace).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: "space",
      permissions: { "network-fetch": "granted" },
    }));
    expect(recordSuccessfulInstall).toHaveBeenCalledWith({ appId: app.id, versionId: version.id });
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
        recordSuccessfulInstall: vi.fn(),
      },
      packages: { ingestRegistryArchive: vi.fn() },
      installations: { installForSpace: vi.fn() },
    })).rejects.toThrow("must be granted");
    expect(downloadVerifiedRelease).not.toHaveBeenCalled();
  });
});

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  loadRequiredAppsPackage,
  parseRequiredAppsReleaseLock,
  reconcileRequiredAppsForSpaces,
  resolveRequiredAppsBundle,
} from "./requiredRegistryAppBootstrap";

const verified = (version = "0.1.2", sha256 = "a".repeat(64)) => ({
  manifest: {
    id: "com.penkra.apps",
    slug: "apps",
    name: "Apps",
    summary: "Manage Apps.",
    version,
    compatibility: { penkra: ">=0.8.0" },
    icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
    entrypoints: { app: "app.html" },
    permissions: [],
    operations: [],
  },
  source: "registry" as const,
  packagePath: `/packages/apps/${version}/${sha256}`,
  sha256,
  installedAt: "2026-08-09T00:00:00.000Z",
});

const installed = (version: string, sha256: string) => {
  const packageValue = verified(version, sha256);
  return {
    ...packageValue,
    appId: packageValue.manifest.id,
    slug: packageValue.manifest.slug,
    name: packageValue.manifest.name,
    summary: packageValue.manifest.summary,
    version: packageValue.manifest.version,
  };
};

function runtimeWithState(state: {
  packagesByInstallationKey: Record<string, unknown>;
  spaceStateByKey: Record<string, unknown>;
}) {
  return {
    installations: {
      snapshot: vi.fn(() => state),
      installForSpace: vi.fn(async () => undefined),
      updateForSpace: vi.fn(async () => undefined),
      recordSideloadRegistryIdentity: vi.fn(async () => undefined),
      setEnabled: vi.fn(async () => undefined),
    },
  };
}

describe("required registry Apps bootstrap", () => {
  it("resolves a packaged archive only when its lock is present", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-required-apps-"));
    try {
      const bundle = Path.join(root, "required-apps");
      FS.mkdirSync(bundle);
      FS.writeFileSync(Path.join(bundle, "apps.penkra"), "archive");
      expect(
        resolveRequiredAppsBundle({
          resourcesPath: root,
          desktopBundleDirectory: "/unused",
          packaged: true,
        }),
      ).toBeNull();
      FS.writeFileSync(Path.join(bundle, "apps.lock.json"), "{}");
      expect(
        resolveRequiredAppsBundle({
          resourcesPath: root,
          desktopBundleDirectory: "/unused",
          packaged: true,
        }),
      ).toEqual({
        kind: "archive",
        archivePath: Path.join(bundle, "apps.penkra"),
        lockPath: Path.join(bundle, "apps.lock.json"),
      });
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the packaged-app fallback when electron-builder omits the extra resource", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-required-apps-"));
    try {
      const desktopBundleDirectory = Path.join(root, "apps/desktop/dist-electron");
      const bundle = Path.join(desktopBundleDirectory, "required-apps");
      FS.mkdirSync(bundle, { recursive: true });
      FS.writeFileSync(Path.join(bundle, "apps.penkra"), "archive");
      FS.writeFileSync(Path.join(bundle, "apps.lock.json"), "{}");

      expect(
        resolveRequiredAppsBundle({
          configuredSourcePath: Path.join(root, "missing-development-source"),
          resourcesPath: Path.join(root, "resources"),
          desktopBundleDirectory,
          packaged: true,
        }),
      ).toEqual({
        kind: "archive",
        archivePath: Path.join(bundle, "apps.penkra"),
        lockPath: Path.join(bundle, "apps.lock.json"),
      });
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("strictly validates the pinned release identity", () => {
    expect(
      parseRequiredAppsReleaseLock({
        schemaVersion: 1,
        appId: "com.penkra.apps",
        slug: "apps",
        version: "0.1.2",
        packageDigest: "a".repeat(64),
        sourceRepository: "penkrahq/penkra-apps",
        sourceCommit: "b".repeat(40),
      }),
    ).toMatchObject({ appId: "com.penkra.apps", version: "0.1.2" });
    expect(() =>
      parseRequiredAppsReleaseLock({
        schemaVersion: 1,
        appId: "com.fake.apps",
        slug: "apps",
        version: "0.1.2",
        packageDigest: "a".repeat(64),
        sourceRepository: "penkrahq/penkra-apps",
        sourceCommit: "b".repeat(40),
      }),
    ).toThrow("invalid");
  });

  it("loads a development directory through ordinary registry ingestion", async () => {
    const packageValue = verified();
    const ingestDirectory = vi.fn(async () => packageValue);
    await expect(
      loadRequiredAppsPackage({
        runtime: { packages: { ingestDirectory } } as never,
        source: { kind: "directory", sourcePath: "/source/apps" },
        hostVersion: "0.9.3",
      }),
    ).resolves.toEqual(packageValue);
    expect(ingestDirectory).toHaveBeenCalledWith({
      sourcePath: "/source/apps",
      source: "registry",
    });
  });

  it("verifies and ingests a pinned release archive", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-required-apps-"));
    try {
      const archivePath = Path.join(root, "apps.penkra");
      const lockPath = Path.join(root, "apps.lock.json");
      const packageBytes = Buffer.from("deterministic Apps archive");
      const packageDigest = createHash("sha256").update(packageBytes).digest("hex");
      FS.writeFileSync(archivePath, packageBytes);
      FS.writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          appId: "com.penkra.apps",
          slug: "apps",
          version: "0.1.2",
          packageDigest,
          sourceRepository: "penkrahq/penkra-apps",
          sourceCommit: "b".repeat(40),
        }),
      );
      const packageValue = verified();
      const ingestRegistryArchive = vi.fn(async () => packageValue);

      await expect(
        loadRequiredAppsPackage({
          runtime: { packages: { ingestRegistryArchive } } as never,
          source: { kind: "archive", archivePath, lockPath },
          hostVersion: "0.9.3",
        }),
      ).resolves.toEqual(packageValue);
      expect(ingestRegistryArchive).toHaveBeenCalledWith({
        packageBytes,
        expectedArchiveDigest: packageDigest,
      });
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an archive whose bytes do not match the release lock", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-required-apps-"));
    try {
      const archivePath = Path.join(root, "apps.penkra");
      const lockPath = Path.join(root, "apps.lock.json");
      FS.writeFileSync(archivePath, "changed archive");
      FS.writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          appId: "com.penkra.apps",
          slug: "apps",
          version: "0.1.2",
          packageDigest: "a".repeat(64),
          sourceRepository: "penkrahq/penkra-apps",
          sourceCommit: "b".repeat(40),
        }),
      );
      const ingestRegistryArchive = vi.fn();

      await expect(
        loadRequiredAppsPackage({
          runtime: { packages: { ingestRegistryArchive } } as never,
          source: { kind: "archive", archivePath, lockPath },
          hostVersion: "0.9.3",
        }),
      ).rejects.toThrow("does not match");
      expect(ingestRegistryArchive).not.toHaveBeenCalled();
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs and enables Apps when a Space has no package", async () => {
    const runtime = runtimeWithState({ packagesByInstallationKey: {}, spaceStateByKey: {} });
    const requiredPackage = verified();
    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: requiredPackage as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
      }),
    ).resolves.toEqual([{ spaceId: "personal", status: "installed" }]);
    expect(runtime.installations.installForSpace).toHaveBeenCalledWith({
      package: requiredPackage,
      spaceId: "personal",
      permissions: {},
    });
  });

  it("rejects an immutable-version collision", async () => {
    const existing = installed("0.1.2", "b".repeat(64));
    const runtime = runtimeWithState({
      packagesByInstallationKey: { "personal\0com.penkra.apps": existing },
      spaceStateByKey: {
        "personal\0com.penkra.apps": {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      },
    });
    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: verified() as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
      }),
    ).rejects.toThrow("different bytes");
  });

  it("preserves an existing package when a source checkout is only the development fallback", async () => {
    const existing = installed("0.1.2", "b".repeat(64));
    const runtime = runtimeWithState({
      packagesByInstallationKey: { "personal\0com.penkra.apps": existing },
      spaceStateByKey: {
        "personal\0com.penkra.apps": {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      },
    });
    const requiredPackage = verified();

    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: requiredPackage as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
        developmentSourcePackage: true,
      }),
    ).resolves.toEqual([{ spaceId: "personal", status: "development-existing" }]);
    expect(runtime.installations.updateForSpace).not.toHaveBeenCalled();
  });

  it("keeps an ownership-proven Required Apps sideload active in a packaged desktop", async () => {
    const existing = {
      ...installed("0.2.0", "b".repeat(64)),
      source: "sideload" as const,
      registryIdentity: {
        appId: "00000000-0000-4000-8000-000000000701",
        publisherId: "00000000-0000-4000-8000-000000000702",
      },
    };
    const runtime = runtimeWithState({
      packagesByInstallationKey: { "personal\0com.penkra.apps": existing },
      spaceStateByKey: {
        "personal\0com.penkra.apps": {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      },
    });

    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: verified() as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
      }),
    ).resolves.toEqual([{ spaceId: "personal", status: "development-sideload" }]);
  });

  it("recovers legacy Required Apps sideload ownership once and persists the proof", async () => {
    const existing = {
      ...installed("0.2.0", "b".repeat(64)),
      source: "sideload" as const,
    };
    const runtime = runtimeWithState({
      packagesByInstallationKey: { "personal\0com.penkra.apps": existing },
      spaceStateByKey: {
        "personal\0com.penkra.apps": {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      },
    });
    const registryIdentity = {
      appId: "00000000-0000-4000-8000-000000000701",
      publisherId: "00000000-0000-4000-8000-000000000702",
    };

    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: verified() as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
        verifySideloadOwnership: vi.fn(async () => registryIdentity),
      }),
    ).resolves.toEqual([{ spaceId: "personal", status: "development-sideload" }]);
    expect(runtime.installations.recordSideloadRegistryIdentity).toHaveBeenCalledWith({
      appId: "com.penkra.apps",
      spaceId: "personal",
      registryIdentity,
    });
  });

  it("retains a newer compatible registry version", async () => {
    const existing = installed("0.2.0", "b".repeat(64));
    const runtime = runtimeWithState({
      packagesByInstallationKey: { "personal\0com.penkra.apps": existing },
      spaceStateByKey: {
        "personal\0com.penkra.apps": {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      },
    });
    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: verified() as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
      }),
    ).resolves.toEqual([{ spaceId: "personal", status: "newer" }]);
    expect(runtime.installations.updateForSpace).not.toHaveBeenCalled();
  });

  it("replaces a newer version that is incompatible with the desktop", async () => {
    const existing = installed("0.2.0", "b".repeat(64));
    existing.manifest.compatibility.penkra = ">=1.0.0";
    const runtime = runtimeWithState({
      packagesByInstallationKey: { "personal\0com.penkra.apps": existing },
      spaceStateByKey: {
        "personal\0com.penkra.apps": {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      },
    });
    const requiredPackage = verified();

    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: requiredPackage as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
      }),
    ).resolves.toEqual([{ spaceId: "personal", status: "updated" }]);
    expect(runtime.installations.updateForSpace).toHaveBeenCalledWith({
      package: requiredPackage,
      spaceId: "personal",
      permissions: {},
    });
  });

  it("replaces an older registry version through the runtime-safe update path", async () => {
    const existing = installed("0.1.1", "b".repeat(64));
    const runtime = runtimeWithState({
      packagesByInstallationKey: { "personal\0com.penkra.apps": existing },
      spaceStateByKey: {
        "personal\0com.penkra.apps": {
          appId: "com.penkra.apps",
          spaceId: "personal",
          enabled: true,
          permissions: {},
        },
      },
    });
    const requiredPackage = verified();
    await expect(
      reconcileRequiredAppsForSpaces({
        runtime: runtime as never,
        requiredPackage: requiredPackage as never,
        hostVersion: "0.9.3",
        spaceIds: ["personal"],
      }),
    ).resolves.toEqual([{ spaceId: "personal", status: "updated" }]);
    expect(runtime.installations.updateForSpace).toHaveBeenCalledWith({
      package: requiredPackage,
      spaceId: "personal",
      permissions: {},
    });
  });
});

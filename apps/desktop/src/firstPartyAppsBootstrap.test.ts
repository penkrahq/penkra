import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  bootstrapFirstPartyAppPackages,
  bootstrapFirstPartyAppsPackage,
  resolveFirstPartyAppPackagePaths,
  resolveFirstPartyAppsPackagePath,
} from "./firstPartyAppsBootstrap";

describe("first-party Apps bootstrap", () => {
  it("prefers an explicit package path and returns null when none exists", () => {
    expect(
      resolveFirstPartyAppsPackagePath({
        configuredPath: "/definitely/missing",
        resourcesPath: "/also/missing",
        desktopBundleDirectory: "/still/missing",
        packaged: true,
      }),
    ).toBeNull();
  });

  it("discovers complete first-party packages beside Apps", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-first-party-apps-"));
    try {
      for (const directory of ["apps", "explorer", "browser"]) {
        FS.mkdirSync(Path.join(root, directory), { recursive: true });
        FS.writeFileSync(Path.join(root, directory, "penkra-app.json"), "{}");
      }
      expect(
        resolveFirstPartyAppPackagePaths({
          configuredPath: Path.join(root, "apps"),
          resourcesPath: "/unused",
          desktopBundleDirectory: "/unused",
          packaged: false,
        }),
      ).toEqual([
        { sourcePath: Path.join(root, "apps"), expectedAppId: "com.penkra.apps" },
        { sourcePath: Path.join(root, "explorer"), expectedAppId: "com.penkra.explorer" },
        { sourcePath: Path.join(root, "browser"), expectedAppId: "com.penkra.browser" },
      ]);
    } finally {
      FS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bootstraps every discovered package", async () => {
    const install = vi.fn(async () => undefined);
    await bootstrapFirstPartyAppPackages(
      {
        packages: {
          ingestDirectory: vi.fn(async ({ sourcePath }: { sourcePath: string }) => ({
            manifest: {
              id: sourcePath.endsWith("explorer") ? "com.penkra.explorer" : "com.penkra.apps",
            },
            sha256: sourcePath.endsWith("explorer") ? "b".repeat(64) : "a".repeat(64),
            source: "registry",
          })),
        },
        installations: {
          snapshot: () => ({ packagesByInstallationKey: {}, spaceStateByKey: {} }),
          install,
          setPermission: vi.fn(),
          setEnabled: vi.fn(),
          updateForSpace: vi.fn(),
        },
      } as never,
      [
        { sourcePath: "/bundle/apps", expectedAppId: "com.penkra.apps" },
        { sourcePath: "/bundle/explorer", expectedAppId: "com.penkra.explorer" },
      ],
      ["space-1"],
    );
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("grants the hosted browser permission to the bundled Browser", async () => {
    const setPermission = vi.fn(async () => undefined);
    await bootstrapFirstPartyAppsPackage(
      {
        packages: {
          ingestDirectory: vi.fn(async () => ({
            manifest: { id: "com.penkra.browser" },
            sha256: "c".repeat(64),
            source: "registry",
          })),
        },
        installations: {
          snapshot: () => ({ packagesByInstallationKey: {}, spaceStateByKey: {} }),
          install: vi.fn(async () => undefined),
          setPermission,
          setEnabled: vi.fn(async () => undefined),
          updateForSpace: vi.fn(),
        },
      } as never,
      "/bundle/browser",
      ["space-1"],
      "com.penkra.browser",
    );
    expect(setPermission).toHaveBeenCalledWith({
      appId: "com.penkra.browser",
      spaceId: "space-1",
      permission: "browser-session",
      grant: "granted",
    });
  });

  it("installs the verified package when the profile has no Apps package", async () => {
    const verified = {
      manifest: { id: "com.penkra.apps" },
      sha256: "a".repeat(64),
      source: "registry",
    };
    const install = vi.fn(async () => undefined);
    const result = await bootstrapFirstPartyAppsPackage(
      {
        packages: { ingestDirectory: vi.fn(async () => verified) },
        installations: {
          snapshot: () => ({ packagesByInstallationKey: {}, spaceStateByKey: {} }),
          install,
          setPermission: vi.fn(),
          setEnabled: vi.fn(),
          updateForSpace: vi.fn(),
        },
      } as never,
      "/package",
      ["space-1"],
    );
    expect(result).toBe("installed");
    expect(install).toHaveBeenCalledWith(verified, "space-1");
  });

  it("updates changed bundled bytes through the runtime-safe Space transition", async () => {
    const verified = {
      manifest: { id: "com.penkra.apps" },
      sha256: "b".repeat(64),
      source: "registry",
    };
    const updateForSpace = vi.fn(async () => undefined);
    const result = await bootstrapFirstPartyAppsPackage(
      {
        packages: { ingestDirectory: vi.fn(async () => verified) },
        installations: {
          snapshot: () => ({
            packagesByInstallationKey: {
              "space-1\0com.penkra.apps": {
                appId: "com.penkra.apps",
                sha256: "a".repeat(64),
              },
            },
            spaceStateByKey: {
              "space-1\0com.penkra.apps": {
                appId: "com.penkra.apps",
                spaceId: "space-1",
                permissions: { "network-fetch": "granted" },
              },
              "space-1:com.example.other": {
                appId: "com.example.other",
                spaceId: "space-1",
                permissions: { "network-fetch": "denied" },
              },
            },
          }),
          install: vi.fn(),
          updateForSpace,
        },
      } as never,
      "/package",
      ["space-1"],
    );
    expect(result).toBe("updated");
    expect(updateForSpace).toHaveBeenCalledWith({
      package: { ...verified, source: "registry" },
      spaceId: "space-1",
      permissions: { "network-fetch": "granted" },
    });
  });
});

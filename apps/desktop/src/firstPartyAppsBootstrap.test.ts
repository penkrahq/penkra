import { describe, expect, it, vi } from "vitest";

import {
  bootstrapFirstPartyAppsPackage,
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
          snapshot: () => ({ packagesByAppId: {}, spaceStateByKey: {} }),
          install,
          updateForSpaces: vi.fn(),
        },
      } as never,
      "/package",
    );
    expect(result).toBe("installed");
    expect(install).toHaveBeenCalledWith(verified);
  });

  it("updates changed bundled bytes through the runtime-safe Space transition", async () => {
    const verified = {
      manifest: { id: "com.penkra.apps" },
      sha256: "b".repeat(64),
      source: "registry",
    };
    const updateForSpaces = vi.fn(async () => undefined);
    const result = await bootstrapFirstPartyAppsPackage(
      {
        packages: { ingestDirectory: vi.fn(async () => verified) },
        installations: {
          snapshot: () => ({
            packagesByAppId: { "com.penkra.apps": { sha256: "a".repeat(64) } },
            spaceStateByKey: {
              "space-1:com.penkra.apps": {
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
          updateForSpaces,
        },
      } as never,
      "/package",
    );
    expect(result).toBe("updated");
    expect(updateForSpaces).toHaveBeenCalledWith({
      package: { ...verified, source: "registry" },
      permissionsBySpace: {
        "space-1": { "network-fetch": "granted" },
      },
    });
  });
});

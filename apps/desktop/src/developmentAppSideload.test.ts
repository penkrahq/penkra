import { describe, expect, it, vi } from "vitest";

import { bootstrapDevelopmentSideload } from "./developmentAppSideload";

const verified = {
  manifest: {
    id: "com.example.canvas",
    permissions: [{ name: "account-data", required: true }],
  },
  source: "sideload" as const,
  sha256: "a".repeat(64),
};

describe("development App sideload bootstrap", () => {
  it("installs a new validated unpacked package", async () => {
    const install = vi.fn(async () => undefined);
    const setPermission = vi.fn(async () => undefined);
    const setEnabled = vi.fn(async () => undefined);
    let snapshots = 0;
    await expect(
      bootstrapDevelopmentSideload(
        {
          packages: { ingestDirectory: vi.fn(async () => verified) },
          installations: {
            snapshot: () =>
              snapshots++ === 0
                ? { packagesByInstallationKey: {}, spaceStateByKey: {} }
                : {
                    packagesByInstallationKey: {},
                    spaceStateByKey: {
                      "personal\0com.example.canvas": {
                        enabled: false,
                        permissions: {},
                      },
                    },
                  },
            install,
            setPermission,
            setEnabled,
          },
        } as never,
        "/work/canvas",
        "personal",
      ),
    ).resolves.toEqual({
      appId: "com.example.canvas",
      sourcePath: "/work/canvas",
      spaceId: "personal",
      status: "installed",
    });
    expect(install).toHaveBeenCalledWith(verified, "personal");
    expect(setPermission).toHaveBeenCalledWith({
      appId: "com.example.canvas",
      spaceId: "personal",
      permission: "account-data",
      grant: "granted",
    });
    expect(setEnabled).toHaveBeenCalledWith({
      appId: "com.example.canvas",
      spaceId: "personal",
      enabled: true,
    });
  });

  it("updates changed sideload bytes through the runtime-safe swap", async () => {
    const updateSideloadForSpace = vi.fn(async () => undefined);
    await expect(
      bootstrapDevelopmentSideload(
        {
          packages: { ingestDirectory: vi.fn(async () => verified) },
          installations: {
            snapshot: () => ({
              packagesByInstallationKey: {
                "personal\0com.example.canvas": {
                  source: "sideload",
                  sha256: "b".repeat(64),
                },
              },
              spaceStateByKey: {
                "personal\0com.example.canvas": {
                  enabled: true,
                  permissions: { "account-data": "granted" },
                },
              },
            }),
            updateSideloadForSpace,
            setPermission: vi.fn(async () => undefined),
            setEnabled: vi.fn(async () => undefined),
          },
        } as never,
        "/work/canvas",
        "personal",
      ),
    ).resolves.toEqual({
      appId: "com.example.canvas",
      sourcePath: "/work/canvas",
      spaceId: "personal",
      status: "updated",
    });
    expect(updateSideloadForSpace).toHaveBeenCalledWith({
      package: verified,
      spaceId: "personal",
    });
  });

  it("repairs an installed current sideload that is still disabled", async () => {
    const setEnabled = vi.fn(async () => undefined);
    let granted = false;
    await expect(
      bootstrapDevelopmentSideload(
        {
          packages: { ingestDirectory: vi.fn(async () => verified) },
          installations: {
            snapshot: () => ({
              packagesByInstallationKey: {
                "personal\0com.example.canvas": verified,
              },
              spaceStateByKey: {
                "personal\0com.example.canvas": {
                  enabled: false,
                  permissions: granted ? { "account-data": "granted" } : {},
                },
              },
            }),
            setPermission: vi.fn(async (input) => {
              granted = input.grant === "granted";
              return undefined;
            }),
            setEnabled,
          },
        } as never,
        "/work/canvas",
        "personal",
      ),
    ).resolves.toEqual({
      appId: "com.example.canvas",
      sourcePath: "/work/canvas",
      spaceId: "personal",
      status: "current",
    });
    expect(setEnabled).toHaveBeenCalledWith({
      appId: "com.example.canvas",
      spaceId: "personal",
      enabled: true,
    });
  });

  it("does not override a registry installation", async () => {
    await expect(
      bootstrapDevelopmentSideload(
        {
          packages: { ingestDirectory: vi.fn(async () => verified) },
          installations: {
            snapshot: () => ({
              packagesByInstallationKey: {
                "personal\0com.example.canvas": {
                  source: "registry",
                  sha256: "b".repeat(64),
                },
              },
            }),
          },
        } as never,
        "/work/canvas",
        "personal",
      ),
    ).rejects.toThrow("already installed from the registry");
  });

  it("atomically replaces the required registry Apps package for development", async () => {
    const apps = {
      ...verified,
      manifest: { ...verified.manifest, id: "com.penkra.apps", permissions: [] },
    };
    const updateSideloadForSpace = vi.fn(async () => undefined);

    await expect(
      bootstrapDevelopmentSideload(
        {
          packages: { ingestDirectory: vi.fn(async () => apps) },
          installations: {
            snapshot: () => ({
              packagesByInstallationKey: {
                "personal\0com.penkra.apps": {
                  appId: "com.penkra.apps",
                  source: "registry",
                  sha256: "b".repeat(64),
                },
              },
              spaceStateByKey: {
                "personal\0com.penkra.apps": { enabled: true, permissions: {} },
              },
            }),
            updateSideloadForSpace,
            setPermission: vi.fn(async () => undefined),
            setEnabled: vi.fn(async () => undefined),
          },
        } as never,
        "/work/apps",
        "personal",
      ),
    ).resolves.toEqual({
      appId: "com.penkra.apps",
      sourcePath: "/work/apps",
      spaceId: "personal",
      status: "updated",
    });
    expect(updateSideloadForSpace).toHaveBeenCalledWith({
      package: apps,
      spaceId: "personal",
    });
  });
});

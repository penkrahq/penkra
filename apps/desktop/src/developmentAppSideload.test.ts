import { describe, expect, it, vi } from "vitest";

import { bootstrapDevelopmentSideload } from "./developmentAppSideload";

const verified = {
  manifest: {
    id: "com.example.canvas",
    version: "2.0.0",
    permissions: [{ name: "account-data", required: true }],
  },
  source: "sideload" as const,
  sha256: "a".repeat(64),
};

describe("development App sideload bootstrap", () => {
  it("authorizes the validated manifest before installing and persists registry identity", async () => {
    const install = vi.fn(async () => undefined);
    const registryIdentity = {
      appId: "00000000-0000-4000-8000-000000000701",
      publisherId: "00000000-0000-4000-8000-000000000702",
    };
    const developmentIdentity = { id: "00000000-0000-4000-8000-000000000703" };
    const authorize = vi.fn(async () => ({ registryIdentity, developmentIdentity }));

    await bootstrapDevelopmentSideload(
      {
        packages: { ingestDirectory: vi.fn(async () => verified) },
        installations: {
          snapshot: () => ({ packagesByInstallationKey: {}, spaceStateByKey: {} }),
          install,
          setPermission: vi.fn(async () => undefined),
          setEnabled: vi.fn(async () => undefined),
        },
      } as never,
      "/work/canvas",
      "personal",
      authorize,
    );

    expect(authorize).toHaveBeenCalledWith({ package: verified, existing: undefined });
    expect(install).toHaveBeenCalledWith(
      { ...verified, registryIdentity, developmentIdentity },
      "personal",
    );
  });

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

  it("routes a registry installation through the guarded sideload update", async () => {
    const updateSideloadForSpace = vi.fn(async () => undefined);
    await expect(
      bootstrapDevelopmentSideload(
        {
          packages: { ingestDirectory: vi.fn(async () => verified) },
          installations: {
            snapshot: () => ({
              packagesByInstallationKey: {
                "personal\0com.example.canvas": {
                  source: "registry",
                  version: "1.0.0",
                  sha256: "b".repeat(64),
                },
              },
              spaceStateByKey: {
                "personal\0com.example.canvas": { enabled: true, permissions: {} },
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
    ).resolves.toMatchObject({ status: "updated" });
    expect(updateSideloadForSpace).toHaveBeenCalledWith({
      package: verified,
      spaceId: "personal",
    });
  });

  it("propagates a rejected registry-to-sideload transition", async () => {
    const apps = {
      ...verified,
      manifest: { ...verified.manifest, id: "com.penkra.apps", permissions: [] },
    };
    const updateSideloadForSpace = vi.fn(async () => {
      throw new Error("sideload version must be newer");
    });

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
                  version: "2.0.0",
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
    ).rejects.toThrow("sideload version must be newer");
  });
});

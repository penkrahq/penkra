import { beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapDefaultRegistryApps } from "./defaultRegistryAppsBootstrap";
import { installRegistryApp } from "./registryAppInstaller";

vi.mock("./registryAppInstaller", () => ({ installRegistryApp: vi.fn(async () => ({})) }));

const listing = (slug: string) => ({
  identifier: `com.penkra.${slug}`,
  slug,
  latestVersion: "1.0.0",
});

describe("default registry Apps bootstrap", () => {
  beforeEach(() => vi.mocked(installRegistryApp).mockClear());

  it("installs optional Explorer and Browser defaults through the registry installer", async () => {
    const registry = { get: vi.fn(async ({ slug }: { slug: string }) => listing(slug)) };
    await bootstrapDefaultRegistryApps({
      runtime: {
        packages: {},
        installations: {
          snapshot: () => ({ packagesByInstallationKey: {}, spaceStateByKey: {} }),
        },
      } as never,
      registry: registry as never,
      hostVersion: "1.0.0",
      spaceIds: ["personal"],
    });

    expect(vi.mocked(installRegistryApp)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(installRegistryApp).mock.calls.map(([input]) => input.request)).toEqual([
      { slug: "explorer", version: "1.0.0", spaceId: "personal", permissions: {} },
      {
        slug: "browser",
        version: "1.0.0",
        spaceId: "personal",
        permissions: { "browser-session": "granted" },
      },
    ]);
  });

  it("honors uninstall markers for optional defaults", async () => {
    const registry = { get: vi.fn(async ({ slug }: { slug: string }) => listing(slug)) };
    await bootstrapDefaultRegistryApps({
      runtime: {
        packages: {},
        installations: {
          snapshot: () => ({
            packagesByInstallationKey: {},
            spaceStateByKey: {
              "personal\0com.penkra.explorer": {
                appId: "com.penkra.explorer",
                spaceId: "personal",
              },
              "personal\0com.penkra.browser": {
                appId: "com.penkra.browser",
                spaceId: "personal",
              },
            },
          }),
        },
      } as never,
      registry: registry as never,
      hostVersion: "1.0.0",
      spaceIds: ["personal"],
    });

    expect(vi.mocked(installRegistryApp)).not.toHaveBeenCalled();
  });

  it("refuses a registry slug that resolves to another immutable identity", async () => {
    await expect(
      bootstrapDefaultRegistryApps({
        runtime: {
          packages: {},
          installations: {
            snapshot: () => ({ packagesByInstallationKey: {}, spaceStateByKey: {} }),
          },
        } as never,
        registry: {
          get: vi.fn(async () => ({ ...listing("apps"), identifier: "com.fake.apps" })),
        } as never,
        hostVersion: "1.0.0",
        spaceIds: ["personal"],
      }),
    ).rejects.toThrow("unexpected identity");
  });
});

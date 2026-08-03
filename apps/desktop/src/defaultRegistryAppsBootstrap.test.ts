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

  it("installs Apps, Explorer, and Browser through the registry installer", async () => {
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

    expect(vi.mocked(installRegistryApp)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(installRegistryApp).mock.calls.map(([input]) => input.request)).toEqual([
      { slug: "apps", version: "1.0.0", spaceId: "personal", permissions: {} },
      { slug: "explorer", version: "1.0.0", spaceId: "personal", permissions: {} },
      {
        slug: "browser",
        version: "1.0.0",
        spaceId: "personal",
        permissions: { "browser-session": "granted" },
      },
    ]);
  });

  it("honors uninstall markers for optional defaults but repairs required Apps", async () => {
    const registry = { get: vi.fn(async ({ slug }: { slug: string }) => listing(slug)) };
    await bootstrapDefaultRegistryApps({
      runtime: {
        packages: {},
        installations: {
          snapshot: () => ({
            packagesByInstallationKey: {},
            spaceStateByKey: {
              "personal\0com.penkra.apps": { appId: "com.penkra.apps", spaceId: "personal" },
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

    expect(vi.mocked(installRegistryApp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installRegistryApp).mock.calls[0]?.[0].request.slug).toBe("apps");
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
        registry: { get: vi.fn(async () => ({ ...listing("apps"), identifier: "com.fake.apps" })) } as never,
        hostVersion: "1.0.0",
        spaceIds: ["personal"],
      }),
    ).rejects.toThrow("unexpected identity");
  });
});

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

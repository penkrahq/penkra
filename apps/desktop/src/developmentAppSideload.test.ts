import { describe, expect, it, vi } from "vitest";

import { bootstrapDevelopmentSideload } from "./developmentAppSideload";

const verified = {
  manifest: { id: "com.example.canvas" },
  source: "sideload" as const,
  sha256: "a".repeat(64),
};

describe("development App sideload bootstrap", () => {
  it("installs a new validated unpacked package", async () => {
    const install = vi.fn(async () => undefined);
    await expect(
      bootstrapDevelopmentSideload(
        {
          packages: { ingestDirectory: vi.fn(async () => verified) },
          installations: { snapshot: () => ({ packagesByInstallationKey: {} }), install },
        } as never,
        "/work/canvas",
        "personal",
      ),
    ).resolves.toBe("installed");
    expect(install).toHaveBeenCalledWith(verified, "personal");
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
            }),
            updateSideloadForSpace,
          },
        } as never,
        "/work/canvas",
        "personal",
      ),
    ).resolves.toBe("updated");
    expect(updateSideloadForSpace).toHaveBeenCalledWith({
      package: verified,
      spaceId: "personal",
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
});

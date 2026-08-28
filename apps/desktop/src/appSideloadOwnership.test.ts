import { describe, expect, it, vi } from "vitest";

import { authorizeAppSideloadIdentity } from "./appSideloadOwnership";

const manifest = { id: "com.penkra.apps", slug: "apps" } as const;
const appId = "00000000-0000-4000-8000-000000000701";
const publisherId = "00000000-0000-4000-8000-000000000702";

describe("App sideload ownership", () => {
  it("allows an identifier that is not registered", async () => {
    await expect(
      authorizeAppSideloadIdentity({
        manifest,
        registry: {
          developerGetAppIdentifierOwnership: vi.fn(async () => ({ status: "unregistered" })),
        } as never,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns durable identity evidence for an App owned by the signed-in developer", async () => {
    await expect(
      authorizeAppSideloadIdentity({
        manifest,
        registry: {
          developerGetAppIdentifierOwnership: vi.fn(async () => ({
            status: "owned",
            appId,
            publisherId,
            slug: "apps",
          })),
        } as never,
      }),
    ).resolves.toEqual({ appId, publisherId });
  });

  it("rejects another developer's registered identifier and registered slug changes", async () => {
    await expect(
      authorizeAppSideloadIdentity({
        manifest,
        registry: {
          developerGetAppIdentifierOwnership: vi.fn(async () => ({
            status: "registered-to-another-account",
          })),
        } as never,
      }),
    ).rejects.toThrow("registered to another developer account");

    await expect(
      authorizeAppSideloadIdentity({
        manifest,
        registry: {
          developerGetAppIdentifierOwnership: vi.fn(async () => ({
            status: "owned",
            appId,
            publisherId,
            slug: "different",
          })),
        } as never,
      }),
    ).rejects.toThrow("registered with slug different");
  });
});

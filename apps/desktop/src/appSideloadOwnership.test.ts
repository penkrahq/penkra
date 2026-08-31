import { describe, expect, it, vi } from "vitest";

import { authorizeAppSideloadIdentity } from "./appSideloadOwnership";

const manifest = { id: "com.penkra.apps", slug: "apps" } as const;
const appId = "00000000-0000-4000-8000-000000000701";
const publisherId = "00000000-0000-4000-8000-000000000702";
const developmentIdentityId = "00000000-0000-4000-8000-000000000703";

describe("App sideload ownership", () => {
  it("claims an unregistered identifier and persists its development identity", async () => {
    await expect(
      authorizeAppSideloadIdentity({
        manifest,
        registry: {
          developerClaimAppSideloadIdentity: vi.fn(async () => ({
            developmentIdentityId,
            identifier: manifest.id,
            slug: manifest.slug,
            identityAudience: null,
          })),
        } as never,
      }),
    ).resolves.toEqual({ developmentIdentity: { id: developmentIdentityId } });
  });

  it("returns durable identity evidence for an App owned by the signed-in developer", async () => {
    await expect(
      authorizeAppSideloadIdentity({
        manifest,
        registry: {
          developerClaimAppSideloadIdentity: vi.fn(async () => ({
            developmentIdentityId,
            identifier: manifest.id,
            slug: manifest.slug,
            identityAudience: null,
            registryIdentity: { appId, publisherId },
          })),
        } as never,
      }),
    ).resolves.toEqual({
      developmentIdentity: { id: developmentIdentityId },
      registryIdentity: { appId, publisherId },
    });
  });

  it("propagates account-service ownership conflicts before installation", async () => {
    await expect(
      authorizeAppSideloadIdentity({
        manifest,
        registry: {
          developerClaimAppSideloadIdentity: vi.fn(async () => {
            throw new Error("This App identifier belongs to another developer account");
          }),
        } as never,
      }),
    ).rejects.toThrow("belongs to another developer account");
  });

  it("registers the exact account-identity audience from the validated manifest", async () => {
    const claim = vi.fn(async () => ({
      developmentIdentityId,
      identifier: manifest.id,
      slug: manifest.slug,
      identityAudience: "api.example.com",
    }));
    await authorizeAppSideloadIdentity({
      manifest: {
        ...manifest,
        permissions: [
          {
            name: "account-identity",
            required: true,
            reason: "Sign in.",
            audience: "api.example.com",
          },
        ],
      },
      registry: { developerClaimAppSideloadIdentity: claim } as never,
    });
    expect(claim).toHaveBeenCalledWith({
      identifier: manifest.id,
      slug: manifest.slug,
      identityAudience: "api.example.com",
    });
  });
});

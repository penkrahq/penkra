import { describe, expect, it, vi } from "vitest";

import { AppRegistryClient } from "./appRegistryClient";

const summary = {
  id: "00000000-0000-4000-8000-000000000301",
  identifier: "com.penkra.canvas",
  slug: "canvas",
  displayName: "Canvas",
  summary: "Create visual documents",
  publisher: {
    slug: "penkra",
    displayName: "Penkra",
    domain: "penkra.com",
    verified: true,
  },
  latestVersion: "1.0.0",
  iconAssetId: "00000000-0000-4000-8000-000000000302",
  installCount: 4,
  rating: 5,
  ratingCount: 1,
};

describe("desktop App registry client", () => {
  it("uses the encrypted account cookie without exposing it in the result", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      items: [summary],
      pageInfo: { nextCursor: null },
    }));
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com/",
      getCookie: () => "better-auth.session_token=secret",
      fetch,
    });

    const result = await client.list({ query: " Canvas ", limit: 20 });

    expect(result.items[0]).toEqual(summary);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.penkra.com/api/registry/apps?query=Canvas&limit=20",
      expect.objectContaining({
        headers: {
          accept: "application/json",
          cookie: "better-auth.session_token=secret",
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("requires an authenticated account before network access", async () => {
    const fetch = vi.fn();
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "",
      fetch,
    });

    await expect(client.list()).rejects.toThrow("Sign in");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed service data at the trusted boundary", async () => {
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        items: [{ ...summary, installCount: -1 }],
        pageInfo: { nextCursor: null },
      })),
    });

    await expect(client.list()).rejects.toThrow("invalid response");
  });

  it("keeps arbitrary URLs and methods out of the Apps renderer API", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        url: "https://downloads.test/icon",
        contentType: "image/png",
        expiresInSeconds: 300,
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }));
    const client = new AppRegistryClient({
      apiUrl: "https://api.penkra.com",
      getCookie: () => "cookie=value",
      fetch,
    });

    await expect(client.getArtifact({
      id: "00000000-0000-4000-8000-000000000302",
      source: "asset",
    })).resolves.toEqual({
      kind: "image",
      contentType: "image/png",
      dataUrl: "data:image/png;base64,AQID",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.penkra.com/api/registry/assets/00000000-0000-4000-8000-000000000302",
      expect.objectContaining({ headers: expect.objectContaining({ cookie: "cookie=value" }) }),
    );
    expect(fetch.mock.calls[1]).toEqual([
      "https://downloads.test/icon",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

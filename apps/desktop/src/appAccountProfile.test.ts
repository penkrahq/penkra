import { describe, expect, it, vi } from "vitest";

import { requestAppAccountProfile } from "./appAccountProfile";

describe("requestAppAccountProfile", () => {
  it("returns the authenticated account profile from the account service", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      name: "Emmanuel",
      email: "emmanuel@example.com",
      emailVerified: true,
      avatarUrl: "https://example.com/avatar.png",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(requestAppAccountProfile({
      apiUrl: "https://account.example.com",
      cookie: "session=value",
      fetch: fetch as typeof globalThis.fetch,
    })).resolves.toEqual({
      name: "Emmanuel",
      email: "emmanuel@example.com",
      emailVerified: true,
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://account.example.com/api/app-account-profile",
      expect.objectContaining({ headers: { accept: "application/json", cookie: "session=value" } }),
    );
  });

  it("rejects missing authentication and malformed service responses", async () => {
    await expect(requestAppAccountProfile({ apiUrl: "https://account.example.com", cookie: "" }))
      .rejects.toMatchObject({ code: "ACCOUNT_REQUIRED" });
    await expect(requestAppAccountProfile({
      apiUrl: "https://account.example.com",
      cookie: "session=value",
      fetch: (async () => new Response(JSON.stringify({ email: 42 }), { status: 200 })) as typeof globalThis.fetch,
    })).rejects.toThrow("invalid Account profile response");
  });
});

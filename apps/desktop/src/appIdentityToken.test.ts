import { describe, expect, it, vi } from "vitest";

import { requestAppIdentityToken } from "./appIdentityToken";

describe("requestAppIdentityToken", () => {
  it("keeps the Account cookie in the trusted request and returns only the token", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ cookie: "session=secret" });
      expect(JSON.parse(String(init?.body))).toEqual({
        appId: "com.borge.studio",
        spaceId: "space-1",
        audience: "api.borge.ai",
      });
      return new Response(
        JSON.stringify({ token: "header.payload.signature", expiresAt: "2026-08-18T12:05:00Z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await expect(
      requestAppIdentityToken({
        apiUrl: "https://api.penkra.com",
        appId: "com.borge.studio",
        spaceId: "space-1",
        audience: "api.borge.ai",
        cookie: "session=secret",
        fetch: fetch as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({
      token: "header.payload.signature",
      expiresAt: "2026-08-18T12:05:00Z",
    });
  });

  it("rejects undeclared-shaped audiences before a request", async () => {
    await expect(
      requestAppIdentityToken({
        apiUrl: "https://api.penkra.com",
        appId: "com.borge.studio",
        spaceId: "space-1",
        audience: "https://api.borge.ai",
        cookie: "session=secret",
      }),
    ).rejects.toThrow("Identity audience is invalid");
  });

  it("preserves the Account API error contract", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          code: "APP_ACCESS_DENIED",
          message: "This Account cannot use the requested App",
          requestId: "<request-id>",
        },
        { status: 403 },
      ),
    );

    const request = requestAppIdentityToken({
      apiUrl: "https://api.penkra.com",
      appId: "com.borge.studio",
      spaceId: "space-1",
      audience: "api.borge.ai",
      cookie: "session=secret",
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(request).rejects.toMatchObject({
      code: "APP_ACCESS_DENIED",
      message: "This Account cannot use the requested App",
    });
  });
});

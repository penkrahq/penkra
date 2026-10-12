import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundHttp, OutboundHttpError } from "@penkra/shared/outboundHttp";

import {
  decodeJwtExpMs,
  decodeKeychainJson,
  refreshOAuthAccessToken,
  OAUTH_REFRESH_DEADLINE_MS,
} from "./credentials.ts";

describe("decodeKeychainJson", () => {
  it("parses raw JSON payloads", () => {
    expect(decodeKeychainJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses hex-encoded JSON payloads (Claude on macOS)", () => {
    const hex = Buffer.from('{"claudeAiOauth":{"accessToken":"t"}}', "utf8").toString("hex");
    expect(decodeKeychainJson(hex)).toEqual({ claudeAiOauth: { accessToken: "t" } });
  });

  it("parses 0x-prefixed hex JSON payloads", () => {
    const hex = Buffer.from('{"claudeAiOauth":{"accessToken":"t"}}', "utf8").toString("hex");
    expect(decodeKeychainJson(`0x${hex}`)).toEqual({ claudeAiOauth: { accessToken: "t" } });
  });

  it("returns null for non-JSON, non-hex values", () => {
    expect(decodeKeychainJson("not-a-token")).toBeNull();
  });
});

describe("decodeJwtExpMs", () => {
  it("decodes the exp claim into epoch milliseconds", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 }), "utf8").toString(
      "base64url",
    );
    expect(decodeJwtExpMs(`header.${payload}.signature`)).toBe(1_700_000_000_000);
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtExpMs("not-a-jwt")).toBeNull();
    expect(decodeJwtExpMs(undefined)).toBeNull();
  });
});

afterEach(() => vi.restoreAllMocks());
describe("refreshOAuthAccessToken deadline", () => {
  const input = {
    service: "oauth-test",
    refreshUrl: "https://example.com/token",
    allowedOrigins: ["https://example.com"],
    refreshToken: "refresh",
    clientId: "client",
  };
  it("propagates the typed timeout with its own required OAuth deadline", async () => {
    const timeout = new OutboundHttpError("timeout", "Token endpoint exceeded its deadline.");
    const request = vi.spyOn(outboundHttp, "request").mockRejectedValue(timeout);
    await expect(refreshOAuthAccessToken(input)).rejects.toBe(timeout);
    expect(request.mock.calls[0]?.[0].policy.deadlineMs).toBe(OAUTH_REFRESH_DEADLINE_MS);
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([401, 200])(
    "keeps null for a rejected or malformed token response (%s)",
    async (status) => {
      vi.spyOn(outboundHttp, "request").mockResolvedValue({
        status,
        headers: new Headers(),
        body: new TextEncoder().encode('{"error":"invalid_token"}'),
        url: input.refreshUrl,
      });
      await expect(refreshOAuthAccessToken(input)).resolves.toBeNull();
    },
  );
});

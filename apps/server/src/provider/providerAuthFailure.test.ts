import { describe, expect, it } from "vitest";

import { classifyProviderAuthFailure } from "./providerAuthFailure.ts";

describe("classifyProviderAuthFailure", () => {
  it("recognizes a rejected service token on ChatGPT sign-in as provider rejection", () => {
    expect(
      classifyProviderAuthFailure({
        detail: "401 Incorrect API key provided",
        authenticationMethodId: "chatgpt",
      })?.kind,
    ).toBe("provider-rejected");
    expect(
      classifyProviderAuthFailure({
        detail: "401 Incorrect API key provided",
        authenticationMethodId: "chatgpt",
      })?.kind,
    ).toBe("provider-rejected");
  });

  it("recognizes rejection after a successful refresh", () => {
    expect(
      classifyProviderAuthFailure({
        detail: "HTTP 401 Unauthorized",
        authenticationMethodId: "claude-account",
        refreshedSuccessfully: true,
      })?.kind,
    ).toBe("provider-rejected");
  });

  it("treats a subscription sign-in 401 as a likely provider rejection", () => {
    expect(
      classifyProviderAuthFailure({
        detail: "401 Unauthorized",
        authenticationMethodId: "claude-account",
      })?.kind,
    ).toBe("provider-rejected");
  });

  it("requests re-authentication for revoked sign-in and bad user keys", () => {
    expect(
      classifyProviderAuthFailure({
        detail: "refresh token revoked",
        authenticationMethodId: "chatgpt",
      })?.kind,
    ).toBe("reauth-required");
    expect(
      classifyProviderAuthFailure({
        detail: "401 Incorrect API key provided",
        authenticationMethodId: "api-key",
      })?.kind,
    ).toBe("reauth-required");
    expect(
      classifyProviderAuthFailure({
        detail: "Authentication required",
        authenticationMethodId: "chatgpt",
      })?.kind,
    ).toBe("reauth-required");
  });

  it("does not open on unrelated errors", () => {
    expect(
      classifyProviderAuthFailure({
        detail: "usage limit reached",
        authenticationMethodId: "chatgpt",
      }),
    ).toBeNull();
  });
});

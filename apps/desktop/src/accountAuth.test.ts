import { describe, expect, it } from "vitest";

import { isPenkraAccountAuthCallbackUrl } from "./accountAuthCallback";
import { resolvePenkraWebsiteOrigin } from "./accountWebsiteOrigin";

describe("Penkra account website origin", () => {
  it("defaults to the live Penkra website", () => {
    expect(resolvePenkraWebsiteOrigin()).toBe("https://penkra.com");
  });

  it("allows localhost HTTP for desktop development", () => {
    expect(resolvePenkraWebsiteOrigin("http://localhost:3000/sign-in?stale=1")).toBe(
      "http://localhost:3000",
    );
  });

  it("rejects insecure remote origins", () => {
    expect(() => resolvePenkraWebsiteOrigin("http://example.com")).toThrow(/HTTPS/);
  });
});

describe("Penkra account auth callback", () => {
  it("accepts the registered Penkra callback with a token", () => {
    expect(
      isPenkraAccountAuthCallbackUrl("com.penkra.app://auth/callback#token=encoded-auth-return"),
    ).toBe(true);
  });

  it("accepts only the callback scheme registered by this app flavor", () => {
    const devCallback = "com.penkra.app.dev://auth/callback#token=encoded-auth-return";
    expect(isPenkraAccountAuthCallbackUrl(devCallback, "com.penkra.app.dev")).toBe(true);
    expect(isPenkraAccountAuthCallbackUrl(devCallback)).toBe(false);
  });

  it("rejects unrelated, malformed, and incomplete URLs", () => {
    expect(isPenkraAccountAuthCallbackUrl("not a URL")).toBe(false);
    expect(isPenkraAccountAuthCallbackUrl("com.penkra.app:/another/path#token=value")).toBe(false);
    expect(isPenkraAccountAuthCallbackUrl("https://penkra.com/auth/callback#token=value")).toBe(
      false,
    );
    expect(isPenkraAccountAuthCallbackUrl("com.penkra.app:/auth/callback")).toBe(false);
    expect(isPenkraAccountAuthCallbackUrl("com.penkra.app:/auth/callback#token=value")).toBe(false);
  });
});

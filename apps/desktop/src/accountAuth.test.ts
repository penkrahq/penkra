import { describe, expect, it } from "vitest";

import { resolvePenkraAccountSignInUrl } from "./accountAuthSignInUrl";
import {
  isPenkraAccountAuthCallbackUrl,
  readPenkraAccountAuthCallbackToken,
} from "./accountAuthCallback";
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
  it("routes numbered development sign-in back to the requesting instance", () => {
    expect(
      resolvePenkraAccountSignInUrl({
        path: "/sign-in",
        websiteOrigin: "http://localhost:3000",
        desktopFlavor: "development",
        developmentInstance: 2,
      }).toString(),
    ).toBe("http://localhost:3000/sign-in?desktop_flavor=development&desktop_instance=2");
  });

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

  it("returns the callback token for Penkra-owned authentication handling", () => {
    expect(
      readPenkraAccountAuthCallbackToken(
        "com.penkra.app://auth/callback#token=encoded%2Fauth%2Breturn",
      ),
    ).toBe("encoded%2Fauth%2Breturn");
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

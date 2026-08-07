import { describe, expect, it } from "vitest";

import {
  PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME,
  PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME,
  resolvePenkraDesktopFlavor,
  PENKRA_DESKTOP_ENTRY_URL,
  PENKRA_DESKTOP_ORIGIN,
  PENKRA_DESKTOP_UPDATE_CHANNEL,
  PENKRA_DEVELOPMENT_BUNDLE_ID,
  PENKRA_PRODUCTION_BUNDLE_ID,
  LEGACY_PENKRA_DESKTOP_SCHEME,
  penkraBundleId,
  penkraDesktopIdentity,
  resolvePenkraDevInstance,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(PENKRA_PRODUCTION_BUNDLE_ID).toBe("com.penkra.app");
    expect(PENKRA_DEVELOPMENT_BUNDLE_ID).toBe("com.penkra.app.dev");
    expect(penkraBundleId(false)).toBe(PENKRA_PRODUCTION_BUNDLE_ID);
    expect(penkraBundleId(true)).toBe(PENKRA_DEVELOPMENT_BUNDLE_ID);
  });

  it("gives Stable and Dev distinct account-auth callback schemes", () => {
    expect(PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME).toBe("com.penkra.app");
    expect(PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME).toBe("com.penkra.app.dev");
    expect(penkraDesktopIdentity("production").accountAuthScheme).toBe(
      PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME,
    );
    expect(penkraDesktopIdentity("development").accountAuthScheme).toBe(
      PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME,
    );
  });

  it("derives stable identities for numbered Dev instances", () => {
    expect(resolvePenkraDevInstance(undefined)).toBe(1);
    expect(resolvePenkraDevInstance("3")).toBe(3);
    expect(() => resolvePenkraDevInstance("0")).toThrow("positive integer");
    expect(penkraDesktopIdentity("development", 1)).toMatchObject({
      displayName: "Penkra Dev",
      bundleId: "com.penkra.app.dev",
      userDataDirectoryName: "penkra-dev",
    });
    expect(penkraDesktopIdentity("development", 3)).toMatchObject({
      displayName: "Penkra Dev 3",
      bundleId: "com.penkra.app.dev.3",
      accountAuthScheme: "com.penkra.app.dev.3",
      userDataDirectoryName: "penkra-dev-3",
    });
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(PENKRA_DESKTOP_ORIGIN).toBe("penkra://app");
    expect(PENKRA_DESKTOP_ENTRY_URL).toBe("penkra://app/index.html");
    expect(LEGACY_PENKRA_DESKTOP_SCHEME).toBe("penkra");
  });

  it("uses the standard channel for Penkra's generic update feed", () => {
    expect(PENKRA_DESKTOP_UPDATE_CHANNEL).toBe("latest");
  });

  it("selects only Stable or Dev from the runtime mode", () => {
    expect(resolvePenkraDesktopFlavor({ isPackaged: true })).toBe("production");
    expect(resolvePenkraDesktopFlavor({ isPackaged: false, requestedFlavor: "development" })).toBe(
      "development",
    );
  });

  it("requires explicit local identity and honors it for branded Dev bundles", () => {
    expect(() => resolvePenkraDesktopFlavor({ isPackaged: false })).toThrow(
      "PENKRA_DESKTOP_FLAVOR=development",
    );
    expect(() =>
      resolvePenkraDesktopFlavor({ isPackaged: false, requestedFlavor: "production" }),
    ).toThrow("Unsupported Penkra desktop flavor");
    expect(resolvePenkraDesktopFlavor({ isPackaged: true, requestedFlavor: "development" })).toBe(
      "development",
    );
    expect(() =>
      resolvePenkraDesktopFlavor({ isPackaged: true, requestedFlavor: "production" }),
    ).toThrow("Unsupported Penkra desktop flavor");
  });
});

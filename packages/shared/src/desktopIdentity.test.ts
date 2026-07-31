import { describe, expect, it } from "vitest";

import {
  PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME,
  PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME,
  resolveSynaraDesktopFlavor,
  SYNARA_DESKTOP_ENTRY_URL,
  SYNARA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_PRODUCTION_BUNDLE_ID,
  LEGACY_SYNARA_DESKTOP_SCHEME,
  synaraBundleId,
  synaraDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(SYNARA_PRODUCTION_BUNDLE_ID).toBe("com.penkra.app");
    expect(SYNARA_DEVELOPMENT_BUNDLE_ID).toBe("com.penkra.app.dev");
    expect(synaraBundleId(false)).toBe(SYNARA_PRODUCTION_BUNDLE_ID);
    expect(synaraBundleId(true)).toBe(SYNARA_DEVELOPMENT_BUNDLE_ID);
  });

  it("gives Stable and Dev distinct account-auth callback schemes", () => {
    expect(PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME).toBe("com.penkra.app");
    expect(PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME).toBe("com.penkra.app.dev");
    expect(synaraDesktopIdentity("production").accountAuthScheme).toBe(
      PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME,
    );
    expect(synaraDesktopIdentity("development").accountAuthScheme).toBe(
      PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME,
    );
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SYNARA_DESKTOP_ORIGIN).toBe("penkra://app");
    expect(SYNARA_DESKTOP_ENTRY_URL).toBe("penkra://app/index.html");
    expect(LEGACY_SYNARA_DESKTOP_SCHEME).toBe("synara");
  });

  it("uses the standard channel for Penkra's generic update feed", () => {
    expect(SYNARA_DESKTOP_UPDATE_CHANNEL).toBe("latest");
  });

  it("selects only Stable or Dev from the runtime mode", () => {
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true })).toBe("development");
  });
});

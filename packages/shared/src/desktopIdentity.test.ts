import { describe, expect, it } from "vitest";

import {
  resolveSynaraDesktopFlavor,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CANARY_DESKTOP_ENTRY_URL,
  SYNARA_CANARY_DESKTOP_ORIGIN,
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

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SYNARA_DESKTOP_ORIGIN).toBe("penkra://app");
    expect(SYNARA_DESKTOP_ENTRY_URL).toBe("penkra://app/index.html");
    expect(LEGACY_SYNARA_DESKTOP_SCHEME).toBe("synara");
  });

  it("uses the standard channel for Penkra's generic update feed", () => {
    expect(SYNARA_DESKTOP_UPDATE_CHANNEL).toBe("latest");
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_CANARY_BUNDLE_ID).toBe("com.penkra.app.canary");
    expect(SYNARA_CANARY_DESKTOP_ORIGIN).toBe("penkra-canary://app");
    expect(SYNARA_CANARY_DESKTOP_ENTRY_URL).toBe("penkra-canary://app/index.html");
    expect(synaraDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Penkra Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: "penkra-canary",
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "penkra-canary",
      defaultHomeDirectoryName: ".penkra-canary",
      usesScriptedUpdates: true,
    });
  });

  it("selects Canary explicitly without changing normal dev and production defaults", () => {
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
  });
});

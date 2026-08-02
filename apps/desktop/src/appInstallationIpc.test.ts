import { describe, expect, it } from "vitest";

import { createEmptyAppInstallationState } from "./appInstallationState";
import {
  parseRemoveAppDataRequest,
  parseSetAppEnabledRequest,
  parseSetAppPermissionRequest,
  parseUninstallAppRequest,
  toDesktopAppInstallationSnapshot,
} from "./appInstallationIpc";

describe("App installation IPC boundary", () => {
  it("serializes the empty trusted state", () => {
    expect(toDesktopAppInstallationSnapshot(createEmptyAppInstallationState())).toEqual({
      installed: [],
      spaces: [],
    });
    expect(toDesktopAppInstallationSnapshot(createEmptyAppInstallationState(), "personal")).toEqual({
      installed: [],
      spaces: [],
      currentSpaceId: "personal",
    });
  });

  it("parses supported mutation requests", () => {
    expect(parseSetAppEnabledRequest({ appId: "com.penkra.apps", spaceId: "work", enabled: true })).toEqual({
      appId: "com.penkra.apps",
      spaceId: "work",
      enabled: true,
    });
    expect(
      parseSetAppPermissionRequest({
        appId: "com.penkra.apps",
        spaceId: "work",
        permission: "apps-install",
        grant: "granted",
      }),
    ).toEqual({
      appId: "com.penkra.apps",
      spaceId: "work",
      permission: "apps-install",
      grant: "granted",
    });
    expect(parseUninstallAppRequest({ appId: "com.penkra.apps", retainData: false })).toEqual({
      appId: "com.penkra.apps",
      retainData: false,
    });
    expect(parseRemoveAppDataRequest({ appId: "com.penkra.apps", spaceId: "work" })).toEqual({
      appId: "com.penkra.apps",
      spaceId: "work",
    });
  });

  it("rejects malformed requests instead of coercing them", () => {
    expect(() => parseSetAppEnabledRequest({ appId: "app", spaceId: "work", enabled: "yes" })).toThrow();
    expect(() => parseSetAppPermissionRequest({ appId: "app", spaceId: "work", permission: "x", grant: "ask" })).toThrow();
    expect(() => parseUninstallAppRequest({ appId: "app" })).toThrow();
    expect(() => parseRemoveAppDataRequest({ appId: "app", spaceId: "" })).toThrow();
  });
});

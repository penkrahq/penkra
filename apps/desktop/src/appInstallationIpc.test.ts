import { describe, expect, it } from "vitest";

import { createEmptyAppInstallationState } from "./appInstallationState";
import {
  parseInstallRegistryAppRequest,
  parseRemoveAppDataRequest,
  parseRollbackRegistryAppRequest,
  parseSetAppEnabledRequest,
  parseSetAppPermissionRequest,
  parseUpdateRegistryAppRequest,
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
    expect(parseInstallRegistryAppRequest({
      slug: "canvas",
      version: "1.0.0",
      spaceId: "work",
      permissions: { "network-fetch": "granted" },
    })).toEqual({
      slug: "canvas",
      version: "1.0.0",
      spaceId: "work",
      permissions: { "network-fetch": "granted" },
    });
    expect(parseSetAppEnabledRequest({ appId: "com.penkra.apps", spaceId: "work", enabled: true })).toEqual({
      appId: "com.penkra.apps",
      spaceId: "work",
      enabled: true,
    });
    expect(parseUpdateRegistryAppRequest({
      slug: "canvas",
      version: "2.0.0",
      permissionsBySpace: { work: { "network-fetch": "granted" } },
    })).toEqual({
      slug: "canvas",
      version: "2.0.0",
      permissionsBySpace: { work: { "network-fetch": "granted" } },
    });
    expect(parseRollbackRegistryAppRequest({
      slug: "canvas",
      version: "1.0.0",
      permissionsBySpace: { work: { "network-fetch": "granted" } },
    })).toEqual({
      slug: "canvas",
      version: "1.0.0",
      permissionsBySpace: { work: { "network-fetch": "granted" } },
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
    expect(() => parseInstallRegistryAppRequest({ slug: "app", version: "1.0.0", spaceId: "work", permissions: { bad: "ask" } })).toThrow();
    expect(() => parseUpdateRegistryAppRequest({ slug: "app", version: "2.0.0", permissionsBySpace: { work: { bad: "ask" } } })).toThrow();
    expect(() => parseRollbackRegistryAppRequest({ slug: "app", version: "1.0.0", permissionsBySpace: { work: { bad: "ask" } } })).toThrow();
  });
});

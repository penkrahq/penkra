import { describe, expect, it } from "vitest";

import { createEmptyAppInstallationState } from "./appInstallationState";
import {
  parseAppSettingKey,
  parseAppSettingTarget,
  parseAppSettingValue,
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
  it("serializes the empty trusted state", async () => {
    await expect(
      toDesktopAppInstallationSnapshot(createEmptyAppInstallationState()),
    ).resolves.toEqual({
      installed: [],
      spaces: [],
    });
    await expect(
      toDesktopAppInstallationSnapshot(createEmptyAppInstallationState(), "personal"),
    ).resolves.toEqual({
        installed: [],
        spaces: [],
        currentSpaceId: "personal",
      });
  });

  it("parses supported mutation requests", () => {
    expect(
      parseInstallRegistryAppRequest({
        slug: "canvas",
        version: "1.0.0",
        spaceId: "work",
        permissions: { "network-fetch": "granted" },
      }),
    ).toEqual({
      slug: "canvas",
      version: "1.0.0",
      spaceId: "work",
      permissions: { "network-fetch": "granted" },
    });
    expect(
      parseSetAppEnabledRequest({ appId: "com.penkra.apps", spaceId: "work", enabled: true }),
    ).toEqual({
      appId: "com.penkra.apps",
      spaceId: "work",
      enabled: true,
    });
    expect(
      parseUpdateRegistryAppRequest({
        slug: "canvas",
        version: "2.0.0",
        spaceId: "work",
        permissions: { "network-fetch": "granted" },
      }),
    ).toEqual({
      slug: "canvas",
      version: "2.0.0",
      spaceId: "work",
      permissions: { "network-fetch": "granted" },
    });
    expect(
      parseRollbackRegistryAppRequest({
        slug: "canvas",
        version: "1.0.0",
        spaceId: "work",
        permissions: { "network-fetch": "granted" },
      }),
    ).toEqual({
      slug: "canvas",
      version: "1.0.0",
      spaceId: "work",
      permissions: { "network-fetch": "granted" },
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
    expect(
      parseUninstallAppRequest({
        appId: "com.penkra.apps",
        spaceId: "work",
        retainData: false,
      }),
    ).toEqual({ appId: "com.penkra.apps", spaceId: "work", retainData: false });
    expect(parseRemoveAppDataRequest({ appId: "com.penkra.apps", spaceId: "work" })).toEqual({
      appId: "com.penkra.apps",
      spaceId: "work",
    });
  });

  it("rejects malformed requests instead of coercing them", () => {
    expect(() =>
      parseSetAppEnabledRequest({ appId: "app", spaceId: "work", enabled: "yes" }),
    ).toThrow();
    expect(() =>
      parseSetAppPermissionRequest({
        appId: "app",
        spaceId: "work",
        permission: "x",
        grant: "ask",
      }),
    ).toThrow();
    expect(() => parseUninstallAppRequest({ appId: "app" })).toThrow();
    expect(() => parseRemoveAppDataRequest({ appId: "app", spaceId: "" })).toThrow();
    expect(() =>
      parseInstallRegistryAppRequest({
        slug: "app",
        version: "1.0.0",
        spaceId: "work",
        permissions: { bad: "ask" },
      }),
    ).toThrow();
    expect(() =>
      parseUpdateRegistryAppRequest({
        slug: "app",
        version: "2.0.0",
        spaceId: "work",
        permissions: { bad: "ask" },
      }),
    ).toThrow();
    expect(() =>
      parseRollbackRegistryAppRequest({
        slug: "app",
        version: "1.0.0",
        spaceId: "work",
        permissions: { bad: "ask" },
      }),
    ).toThrow();
  });

  it("parses schema-driven App setting requests without coercion", () => {
    expect(parseAppSettingTarget({ appId: "com.acme.canvas", spaceId: "personal" })).toEqual({
      appId: "com.acme.canvas",
      spaceId: "personal",
    });
    expect(
      parseAppSettingKey({
        appId: "com.acme.canvas",
        spaceId: "personal",
        key: "density",
      }),
    ).toMatchObject({ key: "density" });
    expect(
      parseAppSettingValue({
        appId: "com.acme.canvas",
        spaceId: "personal",
        key: "density",
        value: "compact",
      }),
    ).toMatchObject({ value: "compact" });
    expect(() =>
      parseAppSettingValue({
        appId: "app",
        spaceId: "space",
        key: "x",
        value: {},
      }),
    ).toThrow("setting value");
  });
});

import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MAC_RELEASE_SIGNING_IDENTITY,
  MICROPHONE_USAGE_DESCRIPTION,
  NODE_PTY_ASAR_UNPACK_GLOBS,
  PARCEL_WATCHER_ASAR_UNPACK_GLOBS,
} from "./lib/desktop-platform-build-config.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { APP_DATA_USAGE_DESCRIPTION } from "./lib/macos-privacy.ts";

describe("createDesktopPlatformBuildConfig", () => {
  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const dmg = config.dmg as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.equal(mac.icon, "icon.icns");
    assert.deepStrictEqual(config.asarUnpack, [
      ...NODE_PTY_ASAR_UNPACK_GLOBS,
      ...PARCEL_WATCHER_ASAR_UNPACK_GLOBS,
    ]);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.identity, MAC_RELEASE_SIGNING_IDENTITY);
    assert.equal(mac.notarize, true);
    assert.equal(dmg.sign, true);
    assert.equal(dmg.writeUpdateInfo, false);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(extendInfo.NSAppDataUsageDescription, APP_DATA_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSScreenCaptureUsageDescription, undefined);
  });

  it("leaves the DMG container unsigned for build-only macOS artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: false,
    });

    assert.deepStrictEqual(config.dmg, { sign: false, writeUpdateInfo: false });
    assert.equal((config.mac as Record<string, unknown>).identity, null);
  });

  it("keeps node-pty unpacked from ASAR in generated build config", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
    });

    assert.deepStrictEqual([...NODE_PTY_ASAR_UNPACK_GLOBS], ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(config.asarUnpack, [
      ...NODE_PTY_ASAR_UNPACK_GLOBS,
      ...PARCEL_WATCHER_ASAR_UNPACK_GLOBS,
    ]);
  });

  it("uses the canonical Pencil-derived Penkra artwork for every macOS icon path", () => {
    assert.equal(BRAND_ASSET_PATHS.productionMacIconPng, "assets/brand/penkra-app-icon-1024.png");
    assert.equal(
      BRAND_ASSET_PATHS.productionMacLegacyIconPng,
      BRAND_ASSET_PATHS.productionMacIconPng,
    );
  });
});

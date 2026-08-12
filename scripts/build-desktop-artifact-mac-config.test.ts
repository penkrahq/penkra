import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MAC_RELEASE_SIGNING_IDENTITY,
  MICROPHONE_USAGE_DESCRIPTION,
  NODE_PTY_ASAR_UNPACK_GLOBS,
  PARCEL_WATCHER_ASAR_UNPACK_GLOBS,
  REQUIRED_APPS_EXTRA_RESOURCE,
} from "./lib/desktop-platform-build-config.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { APP_DATA_USAGE_DESCRIPTION, APPLE_EVENTS_USAGE_DESCRIPTION } from "./lib/macos-privacy.ts";

describe("createDesktopPlatformBuildConfig", () => {
  it("copies the staged required Apps bundle from an ordinary packaged-app directory", () => {
    assert.deepStrictEqual(REQUIRED_APPS_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/required-apps",
      to: "required-apps",
      filter: ["**/*"],
    });
  });

  it("adds explicit privacy descriptions and main-process entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
      notarize: true,
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
    assert.deepStrictEqual(config.extraResources, [
      REQUIRED_APPS_EXTRA_RESOURCE,
      {
        from: "apps/desktop/prod-resources/native",
        to: "native",
        filter: ["**/*"],
      },
    ]);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.identity, MAC_RELEASE_SIGNING_IDENTITY);
    assert.equal(mac.notarize, true);
    assert.equal(dmg.sign, true);
    assert.equal(dmg.writeUpdateInfo, false);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    assert.equal(extendInfo.NSAppDataUsageDescription, APP_DATA_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSAppleEventsUsageDescription, APPLE_EVENTS_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSScreenCaptureUsageDescription, undefined);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const mainEntitlements = readFileSync(resolve(repoRoot, MAC_ENTITLEMENTS_PATH), "utf8");
    const inheritedEntitlements = readFileSync(
      resolve(repoRoot, MAC_INHERITED_ENTITLEMENTS_PATH),
      "utf8",
    );
    assert.match(mainEntitlements, /<key>com\.apple\.security\.automation\.apple-events<\/key>/u);
    assert.equal(
      /<key>com\.apple\.security\.automation\.apple-events<\/key>/u.test(inheritedEntitlements),
      false,
    );
  });

  it("supports production Developer ID signing without notarization for local QA", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
      notarize: false,
    });
    const mac = config.mac as Record<string, unknown>;
    const dmg = config.dmg as Record<string, unknown>;

    assert.equal(mac.identity, MAC_RELEASE_SIGNING_IDENTITY);
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.notarize, false);
    assert.equal(dmg.sign, true);
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

  it("uses an explicitly unsigned manual NSIS configuration for Windows", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
      signed: false,
    });

    assert.deepStrictEqual((config.win as Record<string, unknown>).target, ["nsis"]);
    assert.equal((config.win as Record<string, unknown>).icon, "icon.ico");
    assert.equal((config.win as Record<string, unknown>).verifyUpdateCodeSignature, true);
    assert.deepStrictEqual(config.nsis, { perMachine: false, oneClick: true });
    assert.deepStrictEqual(config.extraResources, [REQUIRED_APPS_EXTRA_RESOURCE]);
  });

  it("rejects signed Windows artifacts until deferred Azure signing is implemented", () => {
    assert.throws(
      () =>
        createDesktopPlatformBuildConfig({
          platform: "win",
          target: "nsis",
          signed: true,
        }),
      /deferred/u,
    );
  });

  it("uses an AppImage configuration for Linux", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
      signed: false,
    });

    assert.deepStrictEqual((config.linux as Record<string, unknown>).target, ["AppImage"]);
    assert.equal((config.linux as Record<string, unknown>).icon, "icon.png");
    assert.equal((config.linux as Record<string, unknown>).category, "Development");
    assert.deepStrictEqual(config.extraResources, [REQUIRED_APPS_EXTRA_RESOURCE]);
  });

  it("uses the canonical Pencil-derived Penkra artwork for every macOS icon path", () => {
    assert.equal(BRAND_ASSET_PATHS.productionMacIconPng, "assets/brand/penkra-app-icon-1024.png");
    assert.equal(
      BRAND_ASSET_PATHS.productionMacLegacyIconPng,
      BRAND_ASSET_PATHS.productionMacIconPng,
    );
  });
});

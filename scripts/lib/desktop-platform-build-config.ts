// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

import { APP_DATA_USAGE_DESCRIPTION, APPLE_EVENTS_USAGE_DESCRIPTION } from "./macos-privacy.ts";

export const MICROPHONE_USAGE_DESCRIPTION =
  "Penkra needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
export const MAC_RELEASE_SIGNING_IDENTITY = "Developer ID Application";
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;
export const PARCEL_WATCHER_ASAR_UNPACK_GLOBS = [
  "node_modules/@parcel/watcher/**",
  "node_modules/@parcel/watcher-*/**",
] as const;
export const REQUIRED_APPS_EXTRA_RESOURCE = {
  from: "apps/desktop/prod-resources/required-apps",
  to: "required-apps",
  filter: ["**/*"],
} as const;
export const BROWSER_EXTENSIONS_EXTRA_RESOURCE = {
  from: "apps/desktop/prod-resources/extensions",
  to: "extensions",
  filter: ["**/*"],
} as const;

export interface DesktopPlatformBuildConfig {
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly dmg?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly extraResources?: ReadonlyArray<Record<string, unknown>>;
  readonly files?: ReadonlyArray<string>;
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly nsis?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  readonly signed?: boolean;
  readonly notarize?: boolean;
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const nativePackaging = {
    asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS, ...PARCEL_WATCHER_ASAR_UNPACK_GLOBS],
    extraResources: [REQUIRED_APPS_EXTRA_RESOURCE, BROWSER_EXTENSIONS_EXTRA_RESOURCE],
  };

  if (input.platform === "win") {
    if (input.signed) {
      throw new Error(
        "Signed Windows artifacts are deferred until the Azure Artifact Signing release plan is implemented and approved.",
      );
    }
    return {
      ...nativePackaging,
      win: {
        target: [input.target],
        icon: "icon.ico",
        verifyUpdateCodeSignature: true,
      },
      nsis: {
        // A user-level installer works without elevation and is compatible with
        // electron-updater's normal install/update ownership model.
        perMachine: false,
        oneClick: true,
      },
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
      linux: {
        target: [input.target],
        icon: "icon.png",
        category: "Development",
      },
    };
  }

  const mac = {
    target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
    icon: MAC_DMG_ICON_PATH,
    category: "public.app-category.developer-tools",
    // Never let electron-builder silently select a development certificate on a
    // workstation that has both development and distribution identities installed.
    // A development-signed update changes the app's designated requirement and can
    // invalidate macOS privacy grants across relaunches.
    identity: input.signed === true ? MAC_RELEASE_SIGNING_IDENTITY : null,
    hardenedRuntime: input.signed === true,
    notarize: input.notarize === true,
    entitlements: MAC_ENTITLEMENTS_PATH,
    entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
    extendInfo: {
      NSAppDataUsageDescription: APP_DATA_USAGE_DESCRIPTION,
      NSAppleEventsUsageDescription: APPLE_EVENTS_USAGE_DESCRIPTION,
      NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
    },
  } satisfies Record<string, unknown>;

  return {
    ...nativePackaging,
    extraResources: [
      REQUIRED_APPS_EXTRA_RESOURCE,
      BROWSER_EXTENSIONS_EXTRA_RESOURCE,
      {
        from: "apps/desktop/prod-resources/native",
        to: "native",
        filter: ["**/*"],
      },
    ],
    dmg: {
      sign: input.signed === true,
      // The signed release flow notarizes and staples the DMG after electron-builder exits.
      // Do not emit a blockmap/update entry whose hashes would describe the pre-stapled image;
      // macOS auto-updates use the separately finalized ZIP artifact.
      writeUpdateInfo: false,
    },
    mac,
  };
}

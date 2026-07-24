// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

export const MICROPHONE_USAGE_DESCRIPTION =
  "Penkra needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
export const MAC_APPSNAP_HELPER_STAGE_PATH =
  "apps/desktop/native/appsnap/build/synara-appsnap-helper";
export const MAC_APPSNAP_HELPER_ASAR_EXCLUSION = "!apps/desktop/native/appsnap/build/**";
export const MAC_APPSNAP_HELPER_BUNDLE_PATH = "Contents/Helpers/synara-appsnap-helper";
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;
export const PARCEL_WATCHER_ASAR_UNPACK_GLOBS = [
  "node_modules/@parcel/watcher/**",
  "node_modules/@parcel/watcher-*/**",
] as const;

export interface DesktopPlatformBuildConfig {
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly dmg?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly mac?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly platform: "mac";
  readonly target: string;
  readonly signed?: boolean;
}

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "mac";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform === "mac" && input.hostPlatform !== "darwin") {
    return [
      "macOS desktop artifacts include the native Swift AppSnap helper.",
      `Build mac/${input.arch} on macOS so the helper can be compiled and signed.`,
      `Current host is ${input.hostPlatform}/${input.hostArch}.`,
    ].join(" ");
  }
  return null;
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const nativePackaging = {
    asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS, ...PARCEL_WATCHER_ASAR_UNPACK_GLOBS],
  };

  const mac = {
    target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
    icon: MAC_DMG_ICON_PATH,
    category: "public.app-category.developer-tools",
    hardenedRuntime: input.signed === true,
    notarize: input.signed === true,
    entitlements: MAC_ENTITLEMENTS_PATH,
    entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
    binaries: [MAC_APPSNAP_HELPER_BUNDLE_PATH],
    // The universal build stages the same pre-lipo'd helper in both app trees.
    // @electron/universal needs this pattern to preserve that existing fat binary.
    x64ArchFiles: MAC_APPSNAP_HELPER_BUNDLE_PATH,
    extendInfo: {
      NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
    },
  } satisfies Record<string, unknown>;

  return {
    ...nativePackaging,
    dmg: {
      sign: input.signed === true,
      // The signed release flow notarizes and staples the DMG after electron-builder exits.
      // Do not emit a blockmap/update entry whose hashes would describe the pre-stapled image;
      // macOS auto-updates use the separately finalized ZIP artifact.
      writeUpdateInfo: false,
    },
    files: ["**/*", MAC_APPSNAP_HELPER_ASAR_EXCLUSION],
    extraFiles: [
      {
        from: MAC_APPSNAP_HELPER_STAGE_PATH,
        to: "Helpers/synara-appsnap-helper",
      },
    ],
    mac,
  };
}

// This file gives every local desktop instance a stable macOS identity.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  penkraDesktopIdentity,
  resolvePenkraDesktopFlavor,
  resolvePenkraDevInstance,
} from "@penkra/shared/desktopIdentity";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacosIcon, resolvePenkraDevIconSource } from "../../../scripts/lib/macos-icon.ts";
import {
  APP_DATA_USAGE_DESCRIPTION,
  APPLE_EVENTS_USAGE_DESCRIPTION,
} from "../../../scripts/lib/macos-privacy.ts";
import { resolveMacDevelopmentSigningIdentity } from "../../../scripts/lib/macos-dev-signing.ts";

const desktopFlavor = resolvePenkraDesktopFlavor({
  isPackaged: false,
  requestedFlavor: process.env.PENKRA_DESKTOP_FLAVOR,
});
const developmentInstance = resolvePenkraDevInstance(process.env.PENKRA_DEV_INSTANCE_NUMBER);
const desktopIdentity = penkraDesktopIdentity(desktopFlavor, developmentInstance);
const APP_DISPLAY_NAME = desktopIdentity.displayName;
const APP_BUNDLE_ID = desktopIdentity.bundleId;
const LAUNCHER_VERSION = 12;
const MICROPHONE_USAGE_DESCRIPTION =
  "Penkra needs microphone access so you can record voice notes and transcribe them into the chat composer.";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");
const MAIN_ENTITLEMENTS_PATH = join(desktopDir, "resources", "entitlements.mac.plist");
const INHERIT_ENTITLEMENTS_PATH = join(desktopDir, "resources", "entitlements.mac.inherit.plist");

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function setPlistJson(plistPath, key, value) {
  const json = JSON.stringify(value);
  const replaceResult = spawnSync("plutil", ["-replace", key, "-json", json, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) return;

  const insertResult = spawnSync("plutil", ["-insert", key, "-json", json, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) return;

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function patchMainBundleInfoPlist(appBundlePath, iconPath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  // Keep Electron's executable name in development so it remains the default
  // Electron host and honors the repository app path passed on the command line.
  setPlistString(infoPlistPath, "CFBundleExecutable", "Electron");
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  setPlistString(infoPlistPath, "NSMicrophoneUsageDescription", MICROPHONE_USAGE_DESCRIPTION);
  setPlistString(infoPlistPath, "NSAppDataUsageDescription", APP_DATA_USAGE_DESCRIPTION);
  setPlistString(infoPlistPath, "NSAppleEventsUsageDescription", APPLE_EVENTS_USAGE_DESCRIPTION);
  setPlistJson(infoPlistPath, "CFBundleURLTypes", [
    {
      CFBundleURLName: "Penkra Account Authentication",
      CFBundleURLSchemes: [desktopIdentity.accountAuthScheme],
    },
  ]);

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) {
    return;
  }

  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    if (!entry.name.startsWith("Electron Helper")) {
      continue;
    }

    const helperPlistPath = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(helperPlistPath)) {
      continue;
    }

    const suffix = entry.name.replace("Electron Helper", "").replace(".app", "").trim();
    const helperName = suffix
      ? `${APP_DISPLAY_NAME} Helper ${suffix}`
      : `${APP_DISPLAY_NAME} Helper`;
    const helperIdSuffix = suffix.replace(/[()]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
    const helperBundleId = helperIdSuffix
      ? `${APP_BUNDLE_ID}.helper.${helperIdSuffix}`
      : `${APP_BUNDLE_ID}.helper`;

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    setPlistString(helperPlistPath, "CFBundleName", helperName);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isMachOFile(filePath) {
  const result = spawnSync("/usr/bin/file", ["-b", filePath], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes("Mach-O");
}

function collectNestedMacCodePaths(appBundlePath) {
  const codeFiles = [];
  const codeBundles = [];
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) return [];

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(entryPath);
        if (/\.(?:app|framework|xpc)$/u.test(entry.name)) {
          codeBundles.push(entryPath);
        }
        continue;
      }
      if (!stat.isFile()) continue;
      if (!entry.name.endsWith(".dylib") && (stat.mode & 0o111) === 0) continue;
      if (isMachOFile(entryPath)) codeFiles.push(entryPath);
    }
  };

  visit(frameworksDir);
  const deepestFirst = (left, right) =>
    right.split("/").length - left.split("/").length || left.localeCompare(right);
  return [...codeFiles.sort(deepestFirst), ...codeBundles.sort(deepestFirst)];
}

function signMacCode(codePath, signingIdentity, entitlementsPath) {
  const entitlementsArgs = entitlementsPath ? ["--entitlements", entitlementsPath] : [];
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--force", "--timestamp=none", "--sign", signingIdentity, ...entitlementsArgs, codePath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to sign ${codePath}: ${result.stderr.trim()}`);
  }
}

function signMacAppInsideOut(appBundlePath, signingIdentity) {
  for (const nestedCodePath of collectNestedMacCodePaths(appBundlePath)) {
    const inheritedEntitlements = /\.(?:app|xpc)$/u.test(nestedCodePath)
      ? INHERIT_ENTITLEMENTS_PATH
      : undefined;
    signMacCode(nestedCodePath, signingIdentity, inheritedEntitlements);
  }
  signMacCode(appBundlePath, signingIdentity, MAIN_ENTITLEMENTS_PATH);
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  // Electron only honors a source app path in default-app mode. Keep the
  // development bundle's on-disk identity canonical while branding its plist.
  const instanceRuntimeDir =
    desktopFlavor === "development"
      ? join(runtimeDir, "instances", String(developmentInstance))
      : runtimeDir;
  const targetAppBundlePath = join(instanceRuntimeDir, "Electron.app");
  const legacyRebrandedBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const copiedBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const targetBinaryPath = copiedBinaryPath;
  const iconPath =
    desktopFlavor === "development"
      ? join(instanceRuntimeDir, "PenkraDev.icns")
      : join(desktopDir, "resources", "icon.icns");
  const metadataPath = join(instanceRuntimeDir, `metadata-${desktopFlavor}.json`);
  const iconSourcePath =
    desktopFlavor === "development"
      ? resolvePenkraDevIconSource(resolve(desktopDir, "..", ".."))
      : iconPath;
  const iconBadgeText = developmentInstance > 1 ? String(developmentInstance) : null;

  mkdirSync(instanceRuntimeDir, { recursive: true });
  const currentMetadata = readJson(metadataPath);
  if (desktopFlavor === "development") {
    if (
      currentMetadata?.iconSourcePath !== iconSourcePath ||
      currentMetadata?.iconBadgeText !== iconBadgeText
    ) {
      rmSync(iconPath, { force: true });
    }
    buildMacosIcon({
      sourcePngPath: iconSourcePath,
      targetIcnsPath: iconPath,
      ...(iconBadgeText ? { badgeText: iconBadgeText } : {}),
    });
  }

  const expectedMetadata = {
    accountAuthScheme: desktopIdentity.accountAuthScheme,
    bundleId: desktopIdentity.bundleId,
    displayName: desktopIdentity.displayName,
    developmentInstance,
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconSourcePath,
    iconBadgeText,
    iconMtimeMs: statSync(iconPath).mtimeMs,
    mainEntitlementsMtimeMs: statSync(MAIN_ENTITLEMENTS_PATH).mtimeMs,
    inheritEntitlementsMtimeMs: statSync(INHERIT_ENTITLEMENTS_PATH).mtimeMs,
    signingIdentity: resolveMacDevelopmentSigningIdentity(),
  };

  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  if (legacyRebrandedBundlePath !== targetAppBundlePath) {
    rmSync(legacyRebrandedBundlePath, { recursive: true, force: true });
  }
  // Electron's framework bundles rely on relative symlinks beneath `Versions/Current`.
  // Node otherwise resolves those links against the source while copying, which leaves
  // absolute links in the cloned bundle and makes macOS reject its code signature.
  cpSync(sourceAppBundlePath, targetAppBundlePath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath);
  patchHelperBundleInfoPlists(targetAppBundlePath);
  signMacAppInsideOut(targetAppBundlePath, expectedMetadata.signingIdentity);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

export function resolveElectronPath() {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath);
}

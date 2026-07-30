// This file mostly exists because we want dev mode to say "Synara (Dev)" instead of "electron"

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolveSynaraDesktopFlavor, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacosIcon, resolvePenkraDevIconSource } from "../../../scripts/lib/macos-icon.ts";
import { resolveMacDevelopmentSigningIdentity } from "../../../scripts/lib/macos-dev-signing.ts";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const desktopFlavor = resolveSynaraDesktopFlavor({
  isDevelopment,
  requestedFlavor: process.env.SYNARA_DESKTOP_FLAVOR,
});
const desktopIdentity = synaraDesktopIdentity(desktopFlavor);
const APP_DISPLAY_NAME = desktopIdentity.displayName;
const APP_BUNDLE_ID = desktopIdentity.bundleId;
const LAUNCHER_VERSION = 8;
const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");

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

function patchMainBundleInfoPlist(appBundlePath, iconPath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleExecutable", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  setPlistString(infoPlistPath, "NSMicrophoneUsageDescription", MICROPHONE_USAGE_DESCRIPTION);

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

function signMacCode(codePath, signingIdentity) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--force", "--timestamp=none", "--sign", signingIdentity, codePath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to sign ${codePath}: ${result.stderr.trim()}`);
  }
}

function signMacAppInsideOut(appBundlePath, signingIdentity) {
  for (const nestedCodePath of collectNestedMacCodePaths(appBundlePath)) {
    signMacCode(nestedCodePath, signingIdentity);
  }
  signMacCode(appBundlePath, signingIdentity);
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const copiedBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", APP_DISPLAY_NAME);
  const iconPath =
    desktopFlavor === "development"
      ? join(runtimeDir, "PenkraDev.icns")
      : join(desktopDir, "resources", "icon.icns");
  const metadataPath = join(runtimeDir, `metadata-${desktopFlavor}.json`);
  const iconSourcePath =
    desktopFlavor === "development"
      ? resolvePenkraDevIconSource(resolve(desktopDir, "..", ".."))
      : iconPath;

  mkdirSync(runtimeDir, { recursive: true });
  const currentMetadata = readJson(metadataPath);
  if (desktopFlavor === "development") {
    if (currentMetadata?.iconSourcePath !== iconSourcePath) {
      rmSync(iconPath, { force: true });
    }
    buildMacosIcon({
      sourcePngPath: iconSourcePath,
      targetIcnsPath: iconPath,
    });
  }

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconSourcePath,
    iconMtimeMs: statSync(iconPath).mtimeMs,
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
  cpSync(sourceAppBundlePath, targetAppBundlePath, { recursive: true });
  renameSync(copiedBinaryPath, targetBinaryPath);
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

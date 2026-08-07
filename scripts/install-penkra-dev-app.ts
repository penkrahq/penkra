// FILE: install-penkra-dev-app.ts
// Purpose: Install a stable macOS Applications launcher for the detached Penkra dev stack.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMacosIcon, resolvePenkraDevIconSource } from "./lib/macos-icon.ts";
import { APP_DATA_USAGE_DESCRIPTION, APPLE_EVENTS_USAGE_DESCRIPTION } from "./lib/macos-privacy.ts";
import { resolveMacDevelopmentSigningIdentity } from "./lib/macos-dev-signing.ts";
export { parseAppleDevelopmentIdentity } from "./lib/macos-dev-signing.ts";
import {
  discoverPenkraBackendRoot,
  discoverPenkraWebsiteRoot,
  resolvePenkraDevWorkspaceConfigPath,
  writePenkraDevWorkspace,
} from "./lib/penkra-dev-workspace.ts";
import {
  DEFAULT_INSTALLED_PENKRA_DEV_INSTANCES,
  resolvePenkraDevInstanceDefinition,
} from "./lib/penkra-dev-instance.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherScriptPath = join(repoRoot, "scripts", "penkra-dev-launcher.ts");
const microphoneUsageDescription =
  "Penkra needs microphone access so you can record voice notes and transcribe them into the chat composer.";
const launcherEntitlementsPath = join(
  repoRoot,
  "scripts",
  "resources",
  "penkra-dev-launcher.entitlements.plist",
);

function resolveBunExecutable(): string {
  const configured = process.env.BUN_EXECUTABLE?.trim();
  if (configured && existsSync(configured)) return resolve(configured);
  const lookup = spawnSync("/usr/bin/which", ["bun"], { encoding: "utf8" });
  const candidate = lookup.status === 0 ? lookup.stdout.trim() : "";
  if (!candidate || !existsSync(candidate)) {
    throw new Error("Cannot install Penkra Dev: Bun is not available.");
  }
  return resolve(candidate);
}

export function resolvePenkraDevLauncherCompileArgs(input: {
  readonly bunExecutable: string;
  readonly launcherScriptPath: string;
  readonly executablePath: string;
  readonly repoRoot: string;
  readonly instance: number;
}): string[] {
  return [
    "build",
    "--compile",
    "--minify",
    "--define",
    `PENKRA_DEV_REPO_ROOT=${JSON.stringify(input.repoRoot)}`,
    "--define",
    `PENKRA_DEV_BUN_EXECUTABLE=${JSON.stringify(input.bunExecutable)}`,
    "--define",
    `PENKRA_DEV_INSTANCE_NUMBER=${JSON.stringify(String(input.instance))}`,
    input.launcherScriptPath,
    "--outfile",
    input.executablePath,
  ];
}

export function resolvePenkraDevLauncherSignArgs(input: {
  readonly entitlementsPath: string;
  readonly signingIdentity: string;
  readonly stagedAppPath: string;
}): string[] {
  return [
    "--force",
    "--deep",
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    input.entitlementsPath,
    "--sign",
    input.signingIdentity,
    input.stagedAppPath,
  ];
}

export function makeInfoPlist(input = resolvePenkraDevInstanceDefinition(1)): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${input.displayName}</string>
  <key>CFBundleExecutable</key>
  <string>${input.executableName}</string>
  <key>CFBundleIconFile</key>
  <string>PenkraDev.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${input.launcherBundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${input.displayName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSMultipleInstancesProhibited</key>
  <true/>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppDataUsageDescription</key>
  <string>${APP_DATA_USAGE_DESCRIPTION}</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>${APPLE_EVENTS_USAGE_DESCRIPTION}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>${microphoneUsageDescription}</string>
</dict>
</plist>
`;
}

function installInstance(input: {
  readonly instance: number;
  readonly bunExecutable: string;
  readonly signingIdentity: string;
}): string {
  const definition = resolvePenkraDevInstanceDefinition(input.instance);
  const temporaryRoot = mkdtempSync(join(tmpdir(), `penkra-dev-${input.instance}-app-`));
  const stagedAppPath = join(temporaryRoot, `${definition.displayName}.app`);
  const contentsPath = join(stagedAppPath, "Contents");
  const macosPath = join(contentsPath, "MacOS");
  const resourcesPath = join(contentsPath, "Resources");
  const executablePath = join(macosPath, definition.executableName);
  const iconPath = join(resourcesPath, "PenkraDev.icns");
  const backupPath = `/Applications/.${definition.displayName}.backup-${String(process.pid)}.app`;

  try {
    mkdirSync(macosPath, { recursive: true });
    mkdirSync(resourcesPath, { recursive: true });
    writeFileSync(join(contentsPath, "Info.plist"), makeInfoPlist(definition));
    const compile = spawnSync(
      input.bunExecutable,
      resolvePenkraDevLauncherCompileArgs({
        bunExecutable: input.bunExecutable,
        launcherScriptPath,
        executablePath,
        repoRoot,
        instance: input.instance,
      }),
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (compile.status !== 0) {
      throw new Error(
        `Could not compile ${definition.displayName} launcher: ${(compile.stderr || compile.stdout).trim()}`,
      );
    }
    buildMacosIcon({
      sourcePngPath: resolvePenkraDevIconSource(repoRoot),
      targetIcnsPath: iconPath,
      ...(input.instance > 1 ? { badgeText: String(input.instance) } : {}),
    });

    const sign = spawnSync(
      "/usr/bin/codesign",
      resolvePenkraDevLauncherSignArgs({
        entitlementsPath: launcherEntitlementsPath,
        signingIdentity: input.signingIdentity,
        stagedAppPath,
      }),
      { encoding: "utf8" },
    );
    if (sign.status !== 0) {
      throw new Error(`Could not sign ${definition.displayName} launcher: ${sign.stderr.trim()}`);
    }

    rmSync(backupPath, { recursive: true, force: true });
    if (existsSync(definition.applicationPath)) {
      renameSync(definition.applicationPath, backupPath);
    }
    try {
      renameSync(stagedAppPath, definition.applicationPath);
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      if (!existsSync(definition.applicationPath) && existsSync(backupPath)) {
        renameSync(backupPath, definition.applicationPath);
      }
      throw error;
    }

    const register = spawnSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", definition.applicationPath],
      { encoding: "utf8" },
    );
    if (register.status !== 0) {
      throw new Error(`Could not register ${definition.displayName}: ${register.stderr.trim()}`);
    }
    return definition.applicationPath;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function install(): void {
  if (process.platform !== "darwin") {
    throw new Error("Penkra Dev Applications launcher is available only on macOS.");
  }
  if (!existsSync(launcherScriptPath)) {
    throw new Error(`Missing launcher runtime: ${launcherScriptPath}`);
  }

  const bunExecutable = resolveBunExecutable();
  const signingIdentity = resolveMacDevelopmentSigningIdentity();
  const configuredBackendRoot = process.env.PENKRA_BACKEND_ROOT?.trim();
  const backendRoot = discoverPenkraBackendRoot({
    desktopRoot: repoRoot,
    ...(configuredBackendRoot ? { configuredBackendRoot } : {}),
  });
  const configuredWebsiteRoot = process.env.PENKRA_WEBSITE_ROOT?.trim();
  const workspace = writePenkraDevWorkspace(
    {
      desktopRoot: repoRoot,
      backendRoot,
      websiteRoot: discoverPenkraWebsiteRoot({
        desktopRoot: repoRoot,
        backendRoot,
        ...(configuredWebsiteRoot ? { configuredWebsiteRoot } : {}),
      }),
    },
    resolvePenkraDevWorkspaceConfigPath(),
  );

  const configuredInstances = process.argv
    .slice(2)
    .filter((argument) => /^\d+$/u.test(argument))
    .map(Number);
  const instances =
    configuredInstances.length > 0
      ? configuredInstances
      : [...DEFAULT_INSTALLED_PENKRA_DEV_INSTANCES];
  const installedPaths = instances.map((instance) =>
    installInstance({ instance, bunExecutable, signingIdentity }),
  );
  rmSync("/Applications/Penkra (Dev).app", { recursive: true, force: true });
  rmSync(join(repoRoot, "apps", "desktop", ".electron-runtime", "Electron.app"), {
    recursive: true,
    force: true,
  });
  rmSync(join(repoRoot, "apps", "desktop", ".electron-runtime", "Penkra (Dev).app"), {
    recursive: true,
    force: true,
  });

  process.stdout.write(
    `Installed Penkra Dev launchers:\n${installedPaths.map((path) => `  ${path}`).join("\n")}\nDesktop repository: ${workspace.desktopRoot}\nBackend repository: ${workspace.backendRoot}\nWebsite repository: ${workspace.websiteRoot}\nBun: ${bunExecutable}\nSigning identity: ${signingIdentity}\n`,
  );
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  install();
}

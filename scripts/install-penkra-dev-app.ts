// FILE: install-penkra-dev-app.ts
// Purpose: Install a stable macOS Applications launcher for the detached Penkra dev stack.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMacosIcon, resolvePenkraDevIconSource } from "./lib/macos-icon.ts";
import { resolveMacDevelopmentSigningIdentity } from "./lib/macos-dev-signing.ts";
export { parseAppleDevelopmentIdentity } from "./lib/macos-dev-signing.ts";
import {
  discoverPenkraBackendRoot,
  discoverPenkraWebsiteRoot,
  resolvePenkraDevWorkspaceConfigPath,
  writePenkraDevWorkspace,
} from "./lib/penkra-dev-workspace.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherScriptPath = join(repoRoot, "scripts", "penkra-dev-launcher.ts");
const targetAppPath = "/Applications/Penkra (Dev).app";
const previousTargetAppPath = "/Applications/Penkra Dev.app";
const bundleIdentifier = "com.penkra.app.dev.launcher";
const executableName = "Penkra (Dev)";

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
}): string[] {
  return [
    "build",
    "--compile",
    "--minify",
    "--define",
    `PENKRA_DEV_REPO_ROOT=${JSON.stringify(input.repoRoot)}`,
    "--define",
    `PENKRA_DEV_BUN_EXECUTABLE=${JSON.stringify(input.bunExecutable)}`,
    input.launcherScriptPath,
    "--outfile",
    input.executablePath,
  ];
}

function makeInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Penkra (Dev)</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIconFile</key>
  <string>PenkraDev.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Penkra (Dev)</string>
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
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function install(): void {
  if (process.platform !== "darwin") {
    throw new Error("Penkra Dev Applications launcher is available only on macOS.");
  }
  if (!existsSync(launcherScriptPath)) {
    throw new Error(`Missing launcher runtime: ${launcherScriptPath}`);
  }

  const bunExecutable = resolveBunExecutable();
  const temporaryRoot = mkdtempSync(join(tmpdir(), "penkra-dev-app-"));
  const stagedAppPath = join(temporaryRoot, "Penkra (Dev).app");
  const contentsPath = join(stagedAppPath, "Contents");
  const macosPath = join(contentsPath, "MacOS");
  const resourcesPath = join(contentsPath, "Resources");
  const executablePath = join(macosPath, executableName);
  const iconPath = join(resourcesPath, "PenkraDev.icns");
  const backupPath = `/Applications/.Penkra Dev.backup-${String(process.pid)}.app`;
  const signingIdentity = resolveMacDevelopmentSigningIdentity();
  const backendRoot = discoverPenkraBackendRoot({
    desktopRoot: repoRoot,
    configuredBackendRoot: process.env.PENKRA_BACKEND_ROOT,
  });
  const workspace = writePenkraDevWorkspace(
    {
      desktopRoot: repoRoot,
      backendRoot,
      websiteRoot: discoverPenkraWebsiteRoot({
        desktopRoot: repoRoot,
        backendRoot,
        configuredWebsiteRoot: process.env.PENKRA_WEBSITE_ROOT,
      }),
    },
    resolvePenkraDevWorkspaceConfigPath(),
  );

  try {
    mkdirSync(macosPath, { recursive: true });
    mkdirSync(resourcesPath, { recursive: true });
    writeFileSync(join(contentsPath, "Info.plist"), makeInfoPlist());
    const compile = spawnSync(
      bunExecutable,
      resolvePenkraDevLauncherCompileArgs({
        bunExecutable,
        launcherScriptPath,
        executablePath,
        repoRoot,
      }),
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (compile.status !== 0) {
      throw new Error(
        `Could not compile Penkra Dev launcher: ${(compile.stderr || compile.stdout).trim()}`,
      );
    }
    buildMacosIcon({
      sourcePngPath: resolvePenkraDevIconSource(repoRoot),
      targetIcnsPath: iconPath,
    });

    const sign = spawnSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--deep",
        "--options",
        "runtime",
        "--timestamp=none",
        "--sign",
        signingIdentity,
        stagedAppPath,
      ],
      { encoding: "utf8" },
    );
    if (sign.status !== 0) {
      throw new Error(`Could not sign Penkra Dev launcher: ${sign.stderr.trim()}`);
    }

    rmSync(backupPath, { recursive: true, force: true });
    if (existsSync(targetAppPath)) {
      renameSync(targetAppPath, backupPath);
    }
    try {
      renameSync(stagedAppPath, targetAppPath);
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      if (!existsSync(targetAppPath) && existsSync(backupPath)) {
        renameSync(backupPath, targetAppPath);
      }
      throw error;
    }

    const register = spawnSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", targetAppPath],
      { encoding: "utf8" },
    );
    if (register.status !== 0) {
      throw new Error(`Could not register Penkra Dev launcher: ${register.stderr.trim()}`);
    }
    if (previousTargetAppPath !== targetAppPath) {
      rmSync(previousTargetAppPath, { recursive: true, force: true });
    }

    process.stdout.write(
      `Installed Penkra Dev launcher at ${targetAppPath}\nDesktop repository: ${workspace.desktopRoot}\nBackend repository: ${workspace.backendRoot}\nWebsite repository: ${workspace.websiteRoot}\nBun: ${bunExecutable}\nSigning identity: ${signingIdentity}\n`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  install();
}

// FILE: simulatorPlatformDiscovery.ts
// Purpose: Discovers host simulator capabilities through official, bounded native commands.
// Layer: Trusted desktop platform boundary

import ChildProcess from "node:child_process";
import FS from "node:fs";
import Path from "node:path";
import Util from "node:util";

import type { AppSimulatorPlatformAvailability } from "@penkra/sdk";

import type { SupportedDesktopPlatform } from "./desktopPlatform";
import {
  parseAndroidSdkManagerDiscovery,
  parseSimctlDiscovery,
  type SimulatorDiscoveryResult,
} from "./simulatorDiscovery";

const execFile = Util.promisify(ChildProcess.execFile);
const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface SimulatorCommandRunner {
  (executable: string, args: ReadonlyArray<string>): Promise<{ stdout: string; stderr: string }>;
}

export interface SimulatorPlatformDiscovery {
  availability: AppSimulatorPlatformAvailability;
  inventory: SimulatorDiscoveryResult;
}

export async function runBoundedSimulatorCommand(
  executable: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile(executable, [...args], {
    encoding: "utf8",
    timeout: DISCOVERY_TIMEOUT_MS,
    maxBuffer: DISCOVERY_MAX_BUFFER_BYTES,
    windowsHide: true,
    shell: false,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function discoverAppleSimulator(
  platform: SupportedDesktopPlatform,
  runner: SimulatorCommandRunner = runBoundedSimulatorCommand,
): Promise<SimulatorPlatformDiscovery> {
  if (platform !== "darwin") {
    return unavailable(
      "ios",
      "unsupported",
      "Apple Simulator is available only on macOS with Xcode.",
    );
  }
  try {
    const { stdout } = await runner("xcrun", ["simctl", "list", "-j", "runtimes", "devicetypes"]);
    const inventory = parseSimctlDiscovery(stdout);
    if (!inventory.runtimes.some((runtime) => runtime.status === "available")) {
      return {
        availability: {
          platform: "ios",
          supported: true,
          status: "setup-required",
          message: "Install a compatible iOS Simulator runtime for the selected Xcode version.",
        },
        inventory,
      };
    }
    return {
      availability: {
        platform: "ios",
        supported: true,
        status: "available",
        message: null,
      },
      inventory,
    };
  } catch (error) {
    return unavailable(
      "ios",
      "setup-required",
      `Install Xcode and an iOS Simulator runtime. ${errorMessage(error)}`,
      true,
    );
  }
}

export async function discoverAndroidSimulator(options: {
  platform: SupportedDesktopPlatform;
  environment?: NodeJS.ProcessEnv;
  runner?: SimulatorCommandRunner;
  pathExists?: (path: string) => Promise<boolean>;
}): Promise<SimulatorPlatformDiscovery> {
  const environment = options.environment ?? process.env;
  const root = resolveAndroidSdkRoot(options.platform, environment);
  if (!root) {
    return unavailable(
      "android",
      "setup-required",
      "Install Android Studio or set ANDROID_HOME/ANDROID_SDK_ROOT.",
      true,
    );
  }
  const extension = options.platform === "win32" ? ".bat" : "";
  const sdkManager = Path.join(root, "cmdline-tools", "latest", "bin", `sdkmanager${extension}`);
  const avdManager = Path.join(root, "cmdline-tools", "latest", "bin", `avdmanager${extension}`);
  const emulator = Path.join(
    root,
    "emulator",
    `emulator${options.platform === "win32" ? ".exe" : ""}`,
  );
  const pathExists = options.pathExists ?? fileExists;
  if (
    !(await pathExists(sdkManager)) ||
    !(await pathExists(avdManager)) ||
    !(await pathExists(emulator))
  ) {
    return unavailable(
      "android",
      "setup-required",
      "Install Android SDK Command-line Tools and Android Emulator from SDK Manager.",
      true,
    );
  }
  try {
    const runner = options.runner ?? runBoundedSimulatorCommand;
    const [packages, profiles] = await Promise.all([
      runner(sdkManager, ["--list"]),
      runner(avdManager, ["list", "device"]),
    ]);
    return {
      availability: {
        platform: "android",
        supported: true,
        status: "available",
        message: null,
      },
      inventory: parseAndroidSdkManagerDiscovery(packages.stdout, profiles.stdout),
    };
  } catch (error) {
    return unavailable(
      "android",
      "setup-required",
      `Android SDK tools could not be queried. ${errorMessage(error)}`,
      true,
    );
  }
}

export function resolveAndroidSdkRoot(
  platform: SupportedDesktopPlatform,
  environment: NodeJS.ProcessEnv,
): string | null {
  const configured = environment.ANDROID_HOME?.trim() || environment.ANDROID_SDK_ROOT?.trim();
  if (configured) return Path.resolve(configured);
  if (platform === "win32" && environment.LOCALAPPDATA) {
    return Path.join(environment.LOCALAPPDATA, "Android", "Sdk");
  }
  if (environment.HOME) {
    return platform === "darwin"
      ? Path.join(environment.HOME, "Library", "Android", "sdk")
      : Path.join(environment.HOME, "Android", "Sdk");
  }
  return null;
}

function unavailable(
  platform: "android" | "ios",
  status: "setup-required" | "unsupported",
  message: string,
  supported = false,
): SimulatorPlatformDiscovery {
  return {
    availability: { platform, supported, status, message },
    inventory: { runtimes: [], deviceTypes: [] },
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await FS.promises.access(path, FS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

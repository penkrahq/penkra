// FILE: appleSimulatorToolchain.ts
// Purpose: Discovers and installs the Appium/XCUITest pair owned by Apple Simulator support.
// Layer: Trusted desktop simulator infrastructure

import FS from "node:fs";
import Path from "node:path";

import type { SimulatorRuntimeInstaller } from "./simulatorRuntimeInstaller";

export const MANAGED_APPIUM_VERSION = "3.6.0";
export const MANAGED_XCUITEST_VERSION = "12.3.1";

export interface AppleSimulatorToolchainPaths {
  appiumExecutable: string;
  appiumHome: string;
  webDriverAgentProject: string;
}

export class AppleSimulatorToolchain {
  readonly #managedRoot: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #pathExists: (path: string) => Promise<boolean>;
  readonly #installer: SimulatorRuntimeInstaller;

  constructor(input: {
    userDataPath: string;
    environment: NodeJS.ProcessEnv;
    pathExists?: (path: string) => Promise<boolean>;
    installer: SimulatorRuntimeInstaller;
  }) {
    this.#managedRoot = Path.join(input.userDataPath, "simulator", "apple", "appium");
    this.#environment = input.environment;
    this.#pathExists = input.pathExists ?? readablePathExists;
    this.#installer = input.installer;
  }

  async resolve(): Promise<AppleSimulatorToolchainPaths | null> {
    const managed = toolchainPaths(this.#managedRoot);
    if (await this.#complete(managed)) return managed;

    const executable = await resolveExecutable("appium", this.#environment, this.#pathExists);
    const home =
      this.#environment.APPIUM_HOME?.trim() ||
      (this.#environment.HOME ? Path.join(this.#environment.HOME, ".appium") : "");
    if (!executable || !home) return null;
    const ambient = { ...toolchainPaths(home), appiumExecutable: executable };
    return (await this.#complete(ambient)) ? ambient : null;
  }

  async install(signal: AbortSignal): Promise<AppleSimulatorToolchainPaths> {
    const existing = await this.resolve();
    if (existing) return existing;
    const npm = await resolveExecutable("npm", this.#environment, this.#pathExists);
    if (!npm) {
      throw toolchainError(
        "NPM_UNAVAILABLE",
        "Installing Apple Simulator automation requires Node.js with npm on this Mac.",
      );
    }
    await FS.promises.mkdir(this.#managedRoot, { recursive: true });
    await this.#installer.install({
      executable: npm,
      args: managedToolchainInstallArguments(this.#managedRoot),
      signal,
    });
    const installed = toolchainPaths(this.#managedRoot);
    if (!(await this.#complete(installed))) {
      throw toolchainError(
        "APPIUM_INSTALL_INCOMPLETE",
        "Appium installation completed without a usable XCUITest driver.",
      );
    }
    return installed;
  }

  async #complete(paths: AppleSimulatorToolchainPaths): Promise<boolean> {
    return (
      (await this.#pathExists(paths.appiumExecutable)) &&
      (await this.#pathExists(paths.webDriverAgentProject))
    );
  }
}

export function managedToolchainInstallArguments(root: string): ReadonlyArray<string> {
  return [
    "install",
    "--prefix",
    root,
    "--save-exact",
    "--no-audit",
    "--no-fund",
    `appium@${MANAGED_APPIUM_VERSION}`,
    `appium-xcuitest-driver@${MANAGED_XCUITEST_VERSION}`,
  ];
}

function toolchainPaths(root: string): AppleSimulatorToolchainPaths {
  return {
    appiumHome: root,
    appiumExecutable: Path.join(root, "node_modules", ".bin", "appium"),
    webDriverAgentProject: Path.join(
      root,
      "node_modules",
      "appium-xcuitest-driver",
      "node_modules",
      "appium-webdriveragent",
      "WebDriverAgent.xcodeproj",
    ),
  };
}

async function resolveExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  for (const root of (environment.PATH ?? "").split(Path.delimiter).filter(Boolean)) {
    const candidate = Path.join(root, name);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function readablePathExists(path: string): Promise<boolean> {
  try {
    await FS.promises.access(path, FS.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function toolchainError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

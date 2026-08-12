// FILE: simulatorAdapterBundle.ts
// Purpose: Composes platform-native simulator adapters and their lazy infrastructure for desktop startup.
// Layer: Trusted desktop simulator bootstrap

import FS from "node:fs";
import Path from "node:path";

import { DefaultAndroidEmulatorControllerFactory } from "./androidEmulatorController";
import { DefaultAndroidEmulatorLauncher } from "./androidEmulatorLauncher";
import { DefaultAndroidEmulatorSessionHost } from "./androidEmulatorSessionHost";
import { AndroidSimulatorAdapter } from "./androidSimulatorAdapter";
import { AppiumAppleSimulatorAutomation } from "./appleAppiumAutomation";
import { DefaultAppleAppiumServerLauncher, type AppleAppiumServer } from "./appleAppiumServer";
import { AppleSimulatorAdapter, type AppleSimulatorAutomation } from "./appleSimulatorAdapter";
import {
  AppleSimulatorToolchain,
  type AppleSimulatorToolchainPaths,
} from "./appleSimulatorToolchain";
import type { SupportedDesktopPlatform } from "./desktopPlatform";
import type { SimulatorAdapter } from "./simulatorManager";
import { DefaultSimulatorNativeCommandRunner } from "./simulatorNativeCommand";
import {
  discoverAndroidSimulator,
  discoverAppleSimulator,
  resolveAndroidSdkRoot,
  type SimulatorPlatformDiscovery,
} from "./simulatorPlatformDiscovery";
import { DefaultSimulatorRuntimeInstaller } from "./simulatorRuntimeInstaller";
import {
  DefaultAndroidSdkLicenseReviewer,
  type AndroidSdkLicensePrompt,
} from "./androidSdkLicenseReviewer";

const DISCOVERY_CACHE_MS = 5_000;

export interface DesktopSimulatorAdapterBundle {
  adapters: ReadonlyArray<SimulatorAdapter>;
  diagnostics: {
    platform: SupportedDesktopPlatform;
    androidSdkRoot: string | null;
    appiumExecutable: string | null;
    webDriverAgentProject: string | null;
  };
  dispose(): Promise<void>;
}

interface SimulatorCatalog {
  discover(): Promise<SimulatorPlatformDiscovery>;
}

export async function createDesktopSimulatorAdapterBundle(input: {
  platform: SupportedDesktopPlatform;
  userDataPath: string;
  environment?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => Promise<boolean>;
  reviewAndroidLicense?(prompt: AndroidSdkLicensePrompt, signal: AbortSignal): Promise<boolean>;
}): Promise<DesktopSimulatorAdapterBundle> {
  const environment = input.environment ?? process.env;
  const pathExists = input.pathExists ?? executableOrReadablePathExists;
  const commands = new DefaultSimulatorNativeCommandRunner();
  const installer = new DefaultSimulatorRuntimeInstaller();
  const licenseReviewer = new DefaultAndroidSdkLicenseReviewer();
  const adapters: SimulatorAdapter[] = [];
  const disposers: Array<() => Promise<void>> = [];

  const androidSdkRoot = resolveAndroidSdkRoot(input.platform, environment);
  const androidCatalog = cachedCatalog(() =>
    discoverAndroidSimulator({
      platform: input.platform,
      environment,
      pathExists,
    }),
  );
  if (input.platform === "darwin" || input.platform === "linux" || input.platform === "win32") {
    const androidTools = resolveAndroidTools(input.platform, androidSdkRoot);
    const launcher = new DefaultAndroidEmulatorLauncher({
      emulator: androidTools.emulator,
      adb: androidTools.adb,
      protoPath: androidTools.proto,
      commands,
      platform: input.platform,
      environment,
    });
    const controllerFactory = new DefaultAndroidEmulatorControllerFactory({
      commands,
      adb: androidTools.adb,
    });
    const sessions = new DefaultAndroidEmulatorSessionHost({
      launcher,
      controllers: controllerFactory,
    });
    adapters.push(
      new AndroidSimulatorAdapter({
        catalog: androidCatalog,
        commands,
        sessions,
        avdManager: androidTools.avdManager,
        sdkManager: androidTools.sdkManager,
        installer,
        licenseReviewer,
        reviewLicense:
          input.reviewAndroidLicense ??
          (async () => {
            throw Object.assign(new Error("Trusted Android SDK license review is unavailable."), {
              code: "LICENSE_REVIEW_UNAVAILABLE",
            });
          }),
      }),
    );
    disposers.push(() => sessions.dispose());
  }

  let appiumExecutable: string | null = null;
  let webDriverAgentProject: string | null = null;
  if (input.platform === "darwin") {
    const toolchain = new AppleSimulatorToolchain({
      userDataPath: input.userDataPath,
      environment,
      pathExists,
      installer,
    });
    const initialToolchain = await toolchain.resolve();
    appiumExecutable = initialToolchain?.appiumExecutable ?? null;
    webDriverAgentProject = initialToolchain?.webDriverAgentProject ?? null;
    const appleCatalog = cachedCatalog(async () => {
      const discovery = await discoverAppleSimulator("darwin");
      if (discovery.availability.status !== "available") return discovery;
      if (!(await toolchain.resolve())) {
        return {
          ...discovery,
          availability: {
            platform: "ios",
            supported: true,
            status: "setup-required",
            message:
              "Install Appium with the XCUITest driver to use Apple Simulator input and display.",
          },
        };
      }
      return discovery;
    });
    const automation = new LazyAppleSimulatorAutomation({
      resolveToolchain: () => toolchain.resolve(),
      environment,
      derivedDataRoot: Path.join(input.userDataPath, "simulator", "apple", "wda-derived-data"),
    });
    adapters.push(
      new AppleSimulatorAdapter({
        catalog: appleCatalog,
        commands,
        automation,
        installer,
        ensureAutomation: async (signal) => {
          if (await toolchain.resolve()) return false;
          await toolchain.install(signal);
          return true;
        },
      }),
    );
    disposers.push(() => automation.dispose());
  }

  let disposed = false;
  return {
    adapters,
    diagnostics: {
      platform: input.platform,
      androidSdkRoot,
      appiumExecutable,
      webDriverAgentProject,
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const results = await Promise.allSettled(disposers.map((dispose) => dispose()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) throw new AggregateError(errors, "Simulator adapter cleanup failed.");
    },
  };
}

class LazyAppleSimulatorAutomation implements AppleSimulatorAutomation {
  readonly #resolveToolchain: () => Promise<AppleSimulatorToolchainPaths | null>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #derivedDataRoot: string;
  readonly #sessions = new Map<
    string,
    { server: AppleAppiumServer; automation: AppiumAppleSimulatorAutomation }
  >();
  readonly #starting = new Map<string, Promise<AppiumAppleSimulatorAutomation>>();
  readonly #closing = new Map<string, Promise<void>>();
  #openQueue: Promise<void> = Promise.resolve();

  constructor(input: {
    resolveToolchain: () => Promise<AppleSimulatorToolchainPaths | null>;
    environment: NodeJS.ProcessEnv;
    derivedDataRoot: string;
  }) {
    this.#resolveToolchain = input.resolveToolchain;
    this.#environment = input.environment;
    this.#derivedDataRoot = input.derivedDataRoot;
  }

  async open(input: {
    udid: string;
    signal: AbortSignal;
    onExit(error: Error): void;
  }): Promise<void> {
    const automation = await this.#ensure(input.udid);
    const opening = this.#openQueue.then(() => automation.open(input));
    this.#openQueue = opening.catch(() => undefined);
    await opening;
  }

  async close(udid: string): Promise<void> {
    const existing = this.#closing.get(udid);
    if (existing) return existing;
    const closing = this.#close(udid);
    this.#closing.set(udid, closing);
    try {
      await closing;
    } finally {
      this.#closing.delete(udid);
    }
  }

  async tap(udid: string, point: { x: number; y: number }): Promise<void> {
    await this.#require(udid).tap(udid, point);
  }

  async swipe(
    udid: string,
    input: Parameters<AppleSimulatorAutomation["swipe"]>[1],
  ): Promise<void> {
    await this.#require(udid).swipe(udid, input);
  }

  async type(udid: string, text: string): Promise<void> {
    await this.#require(udid).type(udid, text);
  }

  async press(
    udid: string,
    button: Parameters<AppleSimulatorAutomation["press"]>[1],
  ): Promise<void> {
    await this.#require(udid).press(udid, button);
  }

  async rotate(udid: string, orientation: "portrait" | "landscape"): Promise<void> {
    await this.#require(udid).rotate(udid, orientation);
  }

  mjpegUrl(udid: string): string {
    return this.#require(udid).mjpegUrl(udid);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.#starting.values());
    const results = await Promise.allSettled(
      [...this.#sessions.keys()].map((udid) => this.close(udid)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, "Apple automation cleanup failed.");
  }

  async #ensure(udid: string): Promise<AppiumAppleSimulatorAutomation> {
    const session = this.#sessions.get(udid);
    if (session) return session.automation;
    if (!(await this.#resolveToolchain())) {
      throw Object.assign(
        new Error("Appium with the XCUITest driver is required for Apple Simulator."),
        { code: "SETUP_REQUIRED" },
      );
    }
    let starting = this.#starting.get(udid);
    if (!starting) {
      starting = this.#start(udid);
      this.#starting.set(udid, starting);
    }
    try {
      return await starting;
    } finally {
      if (this.#starting.get(udid) === starting) this.#starting.delete(udid);
    }
  }

  async #start(udid: string): Promise<AppiumAppleSimulatorAutomation> {
    const toolchain = await this.#resolveToolchain();
    if (!toolchain) {
      throw Object.assign(
        new Error("Appium with the XCUITest driver is required for Apple Simulator."),
        { code: "SETUP_REQUIRED" },
      );
    }
    const server = await new DefaultAppleAppiumServerLauncher({
      appiumExecutable: toolchain.appiumExecutable,
      environment: { ...this.#environment, APPIUM_HOME: toolchain.appiumHome },
    }).start();
    const automation = new AppiumAppleSimulatorAutomation({
      server,
      derivedDataRoot: this.#derivedDataRoot,
    });
    const session = { server, automation };
    this.#sessions.set(udid, session);
    void server.exited.then(() => {
      if (this.#sessions.get(udid) === session) this.#sessions.delete(udid);
    });
    return automation;
  }

  async #close(udid: string): Promise<void> {
    await this.#starting.get(udid)?.catch(() => undefined);
    const session = this.#sessions.get(udid);
    if (!session) return;
    this.#sessions.delete(udid);
    await closeAppleSimulatorAutomationSession(session);
  }

  #require(udid: string): AppiumAppleSimulatorAutomation {
    const automation = this.#sessions.get(udid)?.automation;
    if (!automation) {
      throw Object.assign(new Error("Apple Simulator session is not ready."), {
        code: "SESSION_NOT_READY",
      });
    }
    return automation;
  }
}

export async function closeAppleSimulatorAutomationSession(session: {
  automation: { dispose(): Promise<void> };
  server: { stop(): Promise<void> };
}): Promise<void> {
  let automationError: unknown;
  try {
    await session.automation.dispose();
  } catch (error) {
    automationError = error;
  }

  try {
    await session.server.stop();
  } catch (serverError) {
    throw new AggregateError(
      automationError ? [automationError, serverError] : [serverError],
      "Apple session cleanup failed.",
    );
  }

  // Deleting an Appium/WDA session can reject after that session has already
  // disappeared. Once the owning Appium process group is confirmed stopped,
  // the rejected DELETE no longer represents a live native resource.
}

function cachedCatalog(discover: () => Promise<SimulatorPlatformDiscovery>): SimulatorCatalog {
  let cached: { expiresAt: number; value: SimulatorPlatformDiscovery } | null = null;
  let pending: Promise<SimulatorPlatformDiscovery> | null = null;
  return {
    discover: async () => {
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      pending ??= discover();
      try {
        const value = await pending;
        cached = { expiresAt: Date.now() + DISCOVERY_CACHE_MS, value };
        return value;
      } finally {
        pending = null;
      }
    },
  };
}

function resolveAndroidTools(
  platform: SupportedDesktopPlatform,
  sdkRoot: string | null,
): { emulator: string; adb: string; avdManager: string; sdkManager: string; proto: string } {
  const root = sdkRoot ?? "__missing_android_sdk__";
  return {
    emulator: Path.join(root, "emulator", platform === "win32" ? "emulator.exe" : "emulator"),
    adb: Path.join(root, "platform-tools", platform === "win32" ? "adb.exe" : "adb"),
    avdManager: Path.join(
      root,
      "cmdline-tools",
      "latest",
      "bin",
      platform === "win32" ? "avdmanager.bat" : "avdmanager",
    ),
    sdkManager: Path.join(
      root,
      "cmdline-tools",
      "latest",
      "bin",
      platform === "win32" ? "sdkmanager.bat" : "sdkmanager",
    ),
    proto: Path.join(root, "emulator", "lib", "emulator_controller.proto"),
  };
}

async function executableOrReadablePathExists(path: string): Promise<boolean> {
  try {
    await FS.promises.access(path, FS.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

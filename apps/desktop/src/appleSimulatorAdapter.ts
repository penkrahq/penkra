// FILE: appleSimulatorAdapter.ts
// Purpose: Implements Apple saved-device lifecycle through CoreSimulator and an explicit WDA boundary.
// Layer: Trusted desktop simulator adapter

import type {
  AppSimulatorButton,
  AppSimulatorCreateDeviceInput,
  AppSimulatorDeviceType,
  AppSimulatorEnvironment,
  AppSimulatorRuntime,
  AppSimulatorSavedDevice,
  AppSimulatorSwipeInput,
} from "@penkra/sdk";

import type { SimulatorAdapter, SimulatorAdapterOpenInput } from "./simulatorManager";
import {
  NativeSimulatorCommandError,
  type SimulatorNativeCommandRunner,
} from "./simulatorNativeCommand";
import type { SimulatorPlatformDiscovery } from "./simulatorPlatformDiscovery";
import type { SimulatorRuntimeInstaller } from "./simulatorRuntimeInstaller";

export interface AppleSimulatorAutomation {
  open(input: {
    udid: string;
    signal: AbortSignal;
    usePreinstalledWda?: boolean;
    onExit(error: Error): void;
  }): Promise<void>;
  close(udid: string): Promise<void>;
  tap(udid: string, point: { x: number; y: number }): Promise<void>;
  swipe(udid: string, input: AppSimulatorSwipeInput): Promise<void>;
  type(udid: string, text: string): Promise<void>;
  press(udid: string, button: AppSimulatorButton): Promise<void>;
  rotate(udid: string, orientation: "portrait" | "landscape"): Promise<void>;
  mjpegUrl(udid: string): string;
}

export interface AppleSimulatorCatalog {
  discover(): Promise<SimulatorPlatformDiscovery>;
}

export class AppleSimulatorAdapter implements SimulatorAdapter {
  readonly platform = "ios" as const;
  readonly #catalog: AppleSimulatorCatalog;
  readonly #commands: SimulatorNativeCommandRunner;
  readonly #automation: AppleSimulatorAutomation;
  readonly #installer: SimulatorRuntimeInstaller;
  readonly #ensureAutomation: (signal: AbortSignal) => Promise<boolean>;

  constructor(input: {
    catalog: AppleSimulatorCatalog;
    commands: SimulatorNativeCommandRunner;
    automation: AppleSimulatorAutomation;
    installer: SimulatorRuntimeInstaller;
    ensureAutomation?: (signal: AbortSignal) => Promise<boolean>;
  }) {
    this.#catalog = input.catalog;
    this.#commands = input.commands;
    this.#automation = input.automation;
    this.#installer = input.installer;
    this.#ensureAutomation = input.ensureAutomation ?? (async () => false);
  }

  async availability(): Promise<AppSimulatorEnvironment["platforms"][number]> {
    return (await this.#catalog.discover()).availability;
  }

  async listRuntimes(): Promise<ReadonlyArray<AppSimulatorRuntime>> {
    return (await this.#catalog.discover()).inventory.runtimes;
  }

  async listDeviceTypes(runtimeId?: string): Promise<ReadonlyArray<AppSimulatorDeviceType>> {
    const types = (await this.#catalog.discover()).inventory.deviceTypes;
    return runtimeId ? types.filter((type) => type.runtimeId === runtimeId) : types;
  }

  async createDevice(input: AppSimulatorCreateDeviceInput): Promise<AppSimulatorSavedDevice> {
    const type = (await this.listDeviceTypes(input.runtimeId)).find(
      (candidate) => candidate.id === input.deviceTypeId,
    );
    if (!type) throw adapterError("DEVICE_TYPE_NOT_FOUND", "Apple device type is unavailable.");
    const name = input.name?.trim() || type.name;
    const result = await this.#commands.run({
      executable: "xcrun",
      args: ["simctl", "create", name, input.deviceTypeId, input.runtimeId],
    });
    const udid = Buffer.from(result.stdout).toString("utf8").trim();
    if (!udid || udid.length > 256) {
      throw adapterError("INVALID_NATIVE_DEVICE", "CoreSimulator returned an invalid device ID.");
    }
    return {
      id: udid,
      platform: "ios",
      runtimeId: input.runtimeId,
      deviceTypeId: input.deviceTypeId,
      formFactor: type.formFactor,
      name,
      state: "stopped",
      lastError: null,
    };
  }

  async eraseDevice(device: AppSimulatorSavedDevice): Promise<AppSimulatorSavedDevice> {
    await this.#simctl(["erase", device.id]);
    return { ...device, state: "stopped", lastError: null };
  }

  async deleteDevice(device: AppSimulatorSavedDevice): Promise<void> {
    await this.#simctl(["delete", device.id]);
  }

  async requestSetup(runtimeId: string | undefined, signal: AbortSignal): Promise<void> {
    if (runtimeId) {
      const runtime = (await this.listRuntimes()).find((candidate) => candidate.id === runtimeId);
      if (runtime?.status === "available") return;
      throw adapterError(
        "RUNTIME_NOT_INSTALLABLE",
        "This specific Apple simulator runtime is unavailable to the selected Xcode installation.",
      );
    }
    if (await this.#ensureAutomation(signal)) return;
    await this.#installer.install({
      executable: "xcodebuild",
      args: ["-downloadPlatform", "iOS"],
      signal,
    });
  }

  async open(input: SimulatorAdapterOpenInput): Promise<{ platform: "ios"; udid: string }> {
    const availability = (await this.#catalog.discover()).availability;
    if (availability.status !== "available") {
      throw adapterError(
        "SETUP_REQUIRED",
        availability.message ?? "Apple Simulator prerequisites are unavailable.",
      );
    }
    input.onPhase("preparing");
    try {
      input.onPhase("booting");
      // simctl boots CoreSimulator services without opening Apple's Simulator app.
      // The running device can then reveal whether WDA is already installed, so
      // Appium avoids an unnecessary Xcode rebuild on every saved-device reopen.
      await this.#bootHeadlessly(input.device.id, input.signal);
      await this.#automation.open({
        udid: input.device.id,
        signal: input.signal,
        usePreinstalledWda: await this.#hasInstalledWebDriverAgent(input.device.id),
        onExit: input.onExit,
      });
      return { platform: "ios", udid: input.device.id };
    } catch (error) {
      try {
        await this.close(input.device);
      } catch (cleanupError) {
        throw Object.assign(
          new AggregateError(
            [error, cleanupError],
            "Apple Simulator startup failed and native cleanup was incomplete.",
          ),
          { code: "SESSION_START_CLEANUP_FAILED" },
        );
      }
      throw error;
    }
  }

  async close(device: AppSimulatorSavedDevice): Promise<void> {
    let automationError: unknown;
    try {
      await this.#automation.close(device.id);
    } catch (error) {
      automationError = error;
    }
    try {
      await this.#simctl(["shutdown", device.id]);
    } catch (error) {
      if (!alreadyShutdown(error) && !automationError) throw error;
    }
    if (automationError) throw automationError;
  }

  async capture(device: AppSimulatorSavedDevice): Promise<{ dataUrl: string }> {
    const result = await this.#simctl(["io", device.id, "screenshot", "-"], {
      maxOutputBytes: 16 * 1024 * 1024,
    });
    return { dataUrl: `data:image/png;base64,${Buffer.from(result.stdout).toString("base64")}` };
  }

  async tap(device: AppSimulatorSavedDevice, point: { x: number; y: number }): Promise<void> {
    await this.#automation.tap(device.id, point);
  }

  async swipe(device: AppSimulatorSavedDevice, input: AppSimulatorSwipeInput): Promise<void> {
    await this.#automation.swipe(device.id, input);
  }

  async type(device: AppSimulatorSavedDevice, text: string): Promise<void> {
    await this.#automation.type(device.id, text);
  }

  async press(device: AppSimulatorSavedDevice, button: AppSimulatorButton): Promise<void> {
    await this.#automation.press(device.id, button);
  }

  async rotate(
    device: AppSimulatorSavedDevice,
    orientation: "portrait" | "landscape",
  ): Promise<void> {
    await this.#automation.rotate(device.id, orientation);
  }

  #simctl(
    args: ReadonlyArray<string>,
    options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {},
  ) {
    return this.#commands.run({ executable: "xcrun", args: ["simctl", ...args], ...options });
  }

  async #hasInstalledWebDriverAgent(udid: string): Promise<boolean> {
    try {
      await this.#simctl(
        ["get_app_container", udid, "com.facebook.WebDriverAgentRunner.xctrunner", "app"],
        { timeoutMs: 5_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  async #bootHeadlessly(udid: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#simctl(["boot", udid], { signal, timeoutMs: 30_000 });
    } catch (error) {
      if (!alreadyBooted(error)) throw error;
    }
    await this.#simctl(["bootstatus", udid, "-b"], { signal, timeoutMs: 120_000 });
  }
}

function alreadyShutdown(error: unknown): boolean {
  return (
    commandText(error).includes("current state: Shutdown") ||
    commandText(error).includes("Unable to shutdown device in current state: Shutdown")
  );
}

function alreadyBooted(error: unknown): boolean {
  return (
    commandText(error).includes("current state: Booted") ||
    commandText(error).includes("Unable to boot device in current state: Booted")
  );
}

function commandText(error: unknown): string {
  return error instanceof NativeSimulatorCommandError
    ? `${error.message}\n${error.stderr}`
    : error instanceof Error
      ? error.message
      : String(error);
}

function adapterError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

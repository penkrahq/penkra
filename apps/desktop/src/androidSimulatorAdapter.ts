// FILE: androidSimulatorAdapter.ts
// Purpose: Implements Android saved-device lifecycle through AVD tooling and an explicit emulator-session boundary.
// Layer: Trusted desktop simulator adapter

import Crypto from "node:crypto";

import type {
  AppSimulatorButton,
  AppSimulatorCreateDeviceInput,
  AppSimulatorDeviceType,
  AppSimulatorEnvironment,
  AppSimulatorRuntime,
  AppSimulatorSavedDevice,
  AppSimulatorSwipeInput,
} from "@penkra/sdk";

import type {
  SimulatorAdapter,
  SimulatorAdapterOpenInput,
  SimulatorFrame,
  SimulatorFrameSubscription,
} from "./simulatorManager";
import type { SimulatorNativeCommandRunner } from "./simulatorNativeCommand";
import type { SimulatorPlatformDiscovery } from "./simulatorPlatformDiscovery";
import type { SimulatorRuntimeInstaller } from "./simulatorRuntimeInstaller";
import type {
  AndroidSdkLicensePrompt,
  AndroidSdkLicenseReviewer,
} from "./androidSdkLicenseReviewer";

export interface AndroidEmulatorSessionHost {
  open(input: {
    avdName: string;
    signal: AbortSignal;
    onPhase(phase: "preparing" | "booting"): void;
    onExit(error: Error): void;
  }): Promise<{ serial: string }>;
  close(avdName: string): Promise<void>;
  erase(avdName: string): Promise<void>;
  capture(avdName: string): Promise<{ dataUrl: string }>;
  subscribeFrames(
    avdName: string,
    onFrame: (frame: SimulatorFrame) => void,
    onError: (error: Error) => void,
  ): Promise<SimulatorFrameSubscription>;
  tap(avdName: string, point: { x: number; y: number }): Promise<void>;
  swipe(avdName: string, input: AppSimulatorSwipeInput): Promise<void>;
  type(avdName: string, text: string): Promise<void>;
  press(avdName: string, button: AppSimulatorButton): Promise<void>;
  rotate(avdName: string, orientation: "portrait" | "landscape"): Promise<void>;
}

export interface AndroidSimulatorCatalog {
  discover(): Promise<SimulatorPlatformDiscovery>;
}

export class AndroidSimulatorAdapter implements SimulatorAdapter {
  readonly platform = "android" as const;
  readonly #catalog: AndroidSimulatorCatalog;
  readonly #commands: SimulatorNativeCommandRunner;
  readonly #sessions: AndroidEmulatorSessionHost;
  readonly #avdManager: string;
  readonly #sdkManager: string;
  readonly #installer: SimulatorRuntimeInstaller;
  readonly #licenseReviewer: AndroidSdkLicenseReviewer;
  readonly #reviewLicense: (
    prompt: AndroidSdkLicensePrompt,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly #createId: () => string;

  constructor(input: {
    catalog: AndroidSimulatorCatalog;
    commands: SimulatorNativeCommandRunner;
    sessions: AndroidEmulatorSessionHost;
    avdManager: string;
    sdkManager: string;
    installer: SimulatorRuntimeInstaller;
    licenseReviewer: AndroidSdkLicenseReviewer;
    reviewLicense(prompt: AndroidSdkLicensePrompt, signal: AbortSignal): Promise<boolean>;
    createId?: () => string;
  }) {
    this.#catalog = input.catalog;
    this.#commands = input.commands;
    this.#sessions = input.sessions;
    this.#avdManager = input.avdManager;
    this.#sdkManager = input.sdkManager;
    this.#installer = input.installer;
    this.#licenseReviewer = input.licenseReviewer;
    this.#reviewLicense = input.reviewLicense;
    this.#createId = input.createId ?? Crypto.randomUUID;
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
    const discovery = await this.#catalog.discover();
    const runtime = discovery.inventory.runtimes.find(
      (candidate) => candidate.id === input.runtimeId,
    );
    if (!runtime) throw adapterError("RUNTIME_NOT_FOUND", "Android runtime is unavailable.");
    if (runtime.status !== "available") {
      throw adapterError("RUNTIME_NOT_INSTALLED", "Install the Android system image first.");
    }
    const type = discovery.inventory.deviceTypes.find(
      (candidate) => candidate.runtimeId === input.runtimeId && candidate.id === input.deviceTypeId,
    );
    if (!type) throw adapterError("DEVICE_TYPE_NOT_FOUND", "Android device type is unavailable.");

    const name = input.name?.trim() || type.name;
    const id = avdName(name, this.#createId());
    await this.#commands.run({
      executable: this.#avdManager,
      args: ["create", "avd", "--name", id, "--package", runtime.id, "--device", type.id],
      stdin: "no\n",
      timeoutMs: 3 * 60_000,
    });
    return {
      id,
      platform: "android",
      runtimeId: runtime.id,
      deviceTypeId: type.id,
      formFactor: type.formFactor,
      name,
      state: "stopped",
      lastError: null,
    };
  }

  async eraseDevice(device: AppSimulatorSavedDevice): Promise<AppSimulatorSavedDevice> {
    await this.#sessions.erase(device.id);
    return { ...device, state: "stopped", lastError: null };
  }

  async deleteDevice(device: AppSimulatorSavedDevice): Promise<void> {
    await this.#commands.run({
      executable: this.#avdManager,
      args: ["delete", "avd", "--name", device.id],
    });
  }

  async requestSetup(runtimeId: string | undefined, signal: AbortSignal): Promise<void> {
    if (!runtimeId) {
      throw adapterError(
        "SETUP_ACTION_REQUIRED",
        "Install Android SDK Command-line Tools and Android Emulator before adding a system image.",
      );
    }
    const runtime = (await this.listRuntimes()).find((candidate) => candidate.id === runtimeId);
    if (!runtime || runtime.platform !== "android") {
      throw adapterError("RUNTIME_NOT_FOUND", "Android runtime is unavailable.");
    }
    if (!runtime.installable || runtime.status === "incompatible") {
      throw adapterError("RUNTIME_NOT_INSTALLABLE", "Android runtime cannot be installed here.");
    }
    if (runtime.status === "available") return;
    await this.#licenseReviewer.review({
      executable: this.#sdkManager,
      signal,
      prompt: (license, promptSignal) => this.#reviewLicense(license, promptSignal),
    });
    await this.#installer.install({
      executable: this.#sdkManager,
      args: [runtime.id],
      signal,
    });
  }

  async open(input: SimulatorAdapterOpenInput): Promise<{ platform: "android"; serial: string }> {
    const availability = (await this.#catalog.discover()).availability;
    if (availability.status !== "available") {
      throw adapterError(
        "SETUP_REQUIRED",
        availability.message ?? "Android Emulator prerequisites are unavailable.",
      );
    }
    const target = await this.#sessions.open({
      avdName: input.device.id,
      signal: input.signal,
      onPhase: input.onPhase,
      onExit: input.onExit,
    });
    if (!/^emulator-\d+$/.test(target.serial)) {
      throw adapterError(
        "INVALID_NATIVE_DEVICE",
        "Android Emulator returned an invalid ADB serial.",
      );
    }
    return { platform: "android", serial: target.serial };
  }

  async close(device: AppSimulatorSavedDevice): Promise<void> {
    await this.#sessions.close(device.id);
  }

  async capture(device: AppSimulatorSavedDevice): Promise<{ dataUrl: string }> {
    return this.#sessions.capture(device.id);
  }

  subscribeFrames(
    device: AppSimulatorSavedDevice,
    onFrame: (frame: SimulatorFrame) => void,
    onError: (error: Error) => void,
  ): Promise<SimulatorFrameSubscription> {
    return this.#sessions.subscribeFrames(device.id, onFrame, onError);
  }

  async tap(device: AppSimulatorSavedDevice, point: { x: number; y: number }): Promise<void> {
    await this.#sessions.tap(device.id, point);
  }

  async swipe(device: AppSimulatorSavedDevice, input: AppSimulatorSwipeInput): Promise<void> {
    await this.#sessions.swipe(device.id, input);
  }

  async type(device: AppSimulatorSavedDevice, text: string): Promise<void> {
    await this.#sessions.type(device.id, text);
  }

  async press(device: AppSimulatorSavedDevice, button: AppSimulatorButton): Promise<void> {
    await this.#sessions.press(device.id, button);
  }

  async rotate(
    device: AppSimulatorSavedDevice,
    orientation: "portrait" | "landscape",
  ): Promise<void> {
    await this.#sessions.rotate(device.id, orientation);
  }
}

function avdName(displayName: string, id: string): string {
  const stem =
    displayName
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "device";
  const suffix = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  if (!suffix) throw adapterError("INVALID_DEVICE_ID", "Could not allocate an Android device ID.");
  return `penkra-${stem}-${suffix}`;
}

function adapterError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

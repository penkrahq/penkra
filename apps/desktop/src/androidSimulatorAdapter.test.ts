import { describe, expect, it, vi } from "vitest";

import {
  AndroidSimulatorAdapter,
  type AndroidEmulatorSessionHost,
} from "./androidSimulatorAdapter";
import type { AndroidSdkLicenseReviewer } from "./androidSdkLicenseReviewer";
import type { SimulatorNativeCommandRunner } from "./simulatorNativeCommand";
import type { SimulatorPlatformDiscovery } from "./simulatorPlatformDiscovery";

const discovery: SimulatorPlatformDiscovery = {
  availability: {
    platform: "android" as const,
    supported: true,
    status: "available" as const,
    message: null,
  },
  inventory: {
    runtimes: [
      {
        id: "system-images;android-36;google_apis;arm64-v8a",
        platform: "android" as const,
        name: "Android 36",
        version: "36",
        status: "available" as const,
        installable: true,
        message: null,
      },
    ],
    deviceTypes: [
      {
        id: "pixel_8",
        platform: "android" as const,
        runtimeId: "system-images;android-36;google_apis;arm64-v8a",
        formFactor: "phone" as const,
        name: "Pixel 8",
      },
    ],
  },
};

function fixture() {
  const installer = { install: vi.fn(async () => undefined) };
  const licenseReviewer: AndroidSdkLicenseReviewer = {
    review: vi.fn(async () => undefined),
  };
  const reviewLicense = vi.fn(async () => true);
  const commands: SimulatorNativeCommandRunner = {
    run: vi.fn(async () => ({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    })),
  };
  const sessions: AndroidEmulatorSessionHost = {
    open: vi.fn(async () => ({ serial: "emulator-5554" })),
    close: vi.fn(async () => undefined),
    erase: vi.fn(async () => undefined),
    capture: vi.fn(async () => ({ dataUrl: "data:image/png;base64,frame" })),
    subscribeFrames: vi.fn(async () => ({ stop: vi.fn() })),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    rotate: vi.fn(async () => undefined),
  };
  const adapter = new AndroidSimulatorAdapter({
    catalog: { discover: async () => discovery },
    commands,
    sessions,
    avdManager: "/sdk/cmdline-tools/latest/bin/avdmanager",
    sdkManager: "/sdk/cmdline-tools/latest/bin/sdkmanager",
    installer,
    licenseReviewer,
    reviewLicense,
    createId: () => "12345678-abcd-0000-0000-000000000000",
  });
  return {
    adapter,
    commands,
    sessions,
    installer,
    licenseReviewer,
    reviewLicense,
  };
}

describe("AndroidSimulatorAdapter", () => {
  it("installs a missing system image through official sdkmanager tooling", async () => {
    const { adapter, installer, licenseReviewer } = fixture();
    discovery.inventory.runtimes[0]!.status = "missing";
    const signal = new AbortController().signal;

    await adapter.requestSetup(discovery.inventory.runtimes[0]!.id, signal);

    expect(licenseReviewer.review).toHaveBeenCalledWith({
      executable: "/sdk/cmdline-tools/latest/bin/sdkmanager",
      signal,
      prompt: expect.any(Function),
    });
    expect(installer.install).toHaveBeenCalledWith({
      executable: "/sdk/cmdline-tools/latest/bin/sdkmanager",
      args: [discovery.inventory.runtimes[0]!.id],
      signal,
    });
    discovery.inventory.runtimes[0]!.status = "available";
  });

  it("requires trusted review before installing a missing system image", async () => {
    const { adapter, installer, licenseReviewer, reviewLicense } = fixture();
    discovery.inventory.runtimes[0]!.status = "missing";
    const signal = new AbortController().signal;
    licenseReviewer.review = vi.fn(async (input) => {
      await input.prompt({ text: "Official Android SDK terms", ordinal: 1 }, signal);
    });

    await adapter.requestSetup(discovery.inventory.runtimes[0]!.id, signal);

    expect(reviewLicense).toHaveBeenCalledWith(
      { text: "Official Android SDK terms", ordinal: 1 },
      signal,
    );
    expect(installer.install).toHaveBeenCalledOnce();
    discovery.inventory.runtimes[0]!.status = "available";
  });

  it("creates an owned AVD through official avdmanager tooling", async () => {
    const { adapter, commands } = fixture();
    const device = await adapter.createDevice({
      runtimeId: discovery.inventory.runtimes[0]!.id,
      deviceTypeId: "pixel_8",
      name: "QA Pixel 8",
    });

    expect(device).toMatchObject({
      id: "penkra-QA-Pixel-8-12345678abcd",
      platform: "android",
      name: "QA Pixel 8",
      state: "stopped",
    });
    expect(commands.run).toHaveBeenCalledWith({
      executable: "/sdk/cmdline-tools/latest/bin/avdmanager",
      args: [
        "create",
        "avd",
        "--name",
        device.id,
        "--package",
        discovery.inventory.runtimes[0]!.id,
        "--device",
        "pixel_8",
      ],
      stdin: "no\n",
      timeoutMs: 180_000,
    });
  });

  it("refuses to create from an uninstalled system image", async () => {
    const { adapter, commands } = fixture();
    discovery.inventory.runtimes[0]!.status = "missing";
    await expect(
      adapter.createDevice({
        runtimeId: discovery.inventory.runtimes[0]!.id,
        deviceTypeId: "pixel_8",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_NOT_INSTALLED" });
    expect(commands.run).not.toHaveBeenCalled();
    discovery.inventory.runtimes[0]!.status = "available";
  });

  it("returns the standard ADB serial and forwards lifecycle phases", async () => {
    const { adapter, sessions } = fixture();
    const onPhase = vi.fn();
    vi.mocked(sessions.open).mockImplementationOnce(async (input) => {
      input.onPhase("preparing");
      input.onPhase("booting");
      return { serial: "emulator-5580" };
    });

    const target = await adapter.open({
      device: {
        id: "penkra-device-1",
        platform: "android",
        runtimeId: discovery.inventory.runtimes[0]!.id,
        deviceTypeId: "pixel_8",
        formFactor: "phone",
        name: "Pixel 8",
        state: "stopped",
        lastError: null,
      },
      signal: new AbortController().signal,
      onPhase,
      onExit: vi.fn(),
    });

    expect(target).toEqual({ platform: "android", serial: "emulator-5580" });
    expect(onPhase.mock.calls).toEqual([["preparing"], ["booting"]]);
  });

  it("routes erase, frames, input, rotation, close, and deletion to their owners", async () => {
    const { adapter, commands, sessions } = fixture();
    const device = {
      id: "penkra-device-1",
      platform: "android" as const,
      runtimeId: discovery.inventory.runtimes[0]!.id,
      deviceTypeId: "pixel_8",
      formFactor: "phone" as const,
      name: "Pixel 8",
      state: "stopped" as const,
      lastError: null,
    };

    await expect(adapter.capture(device)).resolves.toEqual({
      dataUrl: "data:image/png;base64,frame",
    });
    await adapter.tap(device, { x: 0.25, y: 0.75 });
    await adapter.rotate(device, "landscape");
    await adapter.eraseDevice(device);
    await adapter.close(device);
    await adapter.deleteDevice(device);

    expect(sessions.capture).toHaveBeenCalledWith(device.id);
    expect(sessions.tap).toHaveBeenCalledWith(device.id, { x: 0.25, y: 0.75 });
    expect(sessions.rotate).toHaveBeenCalledWith(device.id, "landscape");
    expect(sessions.erase).toHaveBeenCalledWith(device.id);
    expect(sessions.close).toHaveBeenCalledWith(device.id);
    expect(commands.run).toHaveBeenLastCalledWith({
      executable: "/sdk/cmdline-tools/latest/bin/avdmanager",
      args: ["delete", "avd", "--name", device.id],
    });
  });
});

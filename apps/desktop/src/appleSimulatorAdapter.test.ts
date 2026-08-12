import { describe, expect, it, vi } from "vitest";

import { AppleSimulatorAdapter, type AppleSimulatorAutomation } from "./appleSimulatorAdapter";
import type { SimulatorPlatformDiscovery } from "./simulatorPlatformDiscovery";

function fixture() {
  const installer = { install: vi.fn(async () => undefined) };
  const discovery = {
    availability: {
      platform: "ios" as const,
      supported: true,
      status: "available" as const,
      message: null,
    },
    inventory: {
      runtimes: [
        {
          id: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          platform: "ios" as const,
          name: "iOS 26.0",
          version: "26.0",
          status: "available" as const,
          installable: false,
          message: null,
        },
      ],
      deviceTypes: [
        {
          id: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          platform: "ios" as const,
          runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          formFactor: "phone" as const,
          name: "iPhone 17",
        },
      ],
    },
  };
  const commands = {
    run: vi.fn(async ({ args }: { args: ReadonlyArray<string> }) => ({
      stdout: args.includes("create")
        ? Buffer.from("00000000-0000-4000-8000-000000000001\n")
        : args.includes("screenshot")
          ? Buffer.from("png")
          : new Uint8Array(),
      stderr: new Uint8Array(),
    })),
  };
  const automation: AppleSimulatorAutomation = {
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    rotate: vi.fn(async () => undefined),
    mjpegUrl: vi.fn(() => "http://127.0.0.1:9100"),
  };
  const adapter = new AppleSimulatorAdapter({
    catalog: { discover: vi.fn(async () => discovery) },
    commands,
    automation,
    installer,
  });
  return { adapter, commands, automation, installer };
}

describe("AppleSimulatorAdapter", () => {
  it("installs missing automation support before downloading another Apple runtime", async () => {
    const { commands, automation, installer } = fixture();
    const ensureAutomation = vi.fn(async () => true);
    const configured = new AppleSimulatorAdapter({
      catalog: {
        discover: vi.fn(
          async (): Promise<SimulatorPlatformDiscovery> => ({
            availability: {
              platform: "ios",
              supported: true,
              status: "setup-required",
              message: "Install Apple automation support.",
            },
            inventory: { runtimes: [], deviceTypes: [] },
          }),
        ),
      },
      commands,
      automation,
      installer,
      ensureAutomation,
    });
    const signal = new AbortController().signal;

    await configured.requestSetup(undefined, signal);

    expect(ensureAutomation).toHaveBeenCalledWith(signal);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("installs the latest iOS runtime through official xcodebuild tooling", async () => {
    const { adapter, installer } = fixture();
    const signal = new AbortController().signal;

    await adapter.requestSetup(undefined, signal);

    expect(installer.install).toHaveBeenCalledWith({
      executable: "xcodebuild",
      args: ["-downloadPlatform", "iOS"],
      signal,
    });
  });

  it("creates ordinary CoreSimulator devices and returns the standard UDID", async () => {
    const { adapter, commands } = fixture();

    const device = await adapter.createDevice({
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      name: "My iPhone",
    });

    expect(commands.run).toHaveBeenCalledWith({
      executable: "xcrun",
      args: [
        "simctl",
        "create",
        "My iPhone",
        "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      ],
    });
    expect(device).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      platform: "ios",
      state: "stopped",
    });
  });

  it("lets the headless WDA boundary own boot without exposing Simulator UI", async () => {
    const { adapter, commands, automation } = fixture();
    const onPhase = vi.fn();
    const onExit = vi.fn();

    const target = await adapter.open({
      device: {
        id: "udid-1",
        platform: "ios",
        runtimeId: "runtime",
        deviceTypeId: "type",
        formFactor: "phone",
        name: "iPhone",
        state: "stopped",
        lastError: null,
      },
      signal: new AbortController().signal,
      onPhase,
      onExit,
    });

    expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual(["preparing", "booting"]);
    expect(commands.run).toHaveBeenNthCalledWith(1, {
      executable: "xcrun",
      args: ["simctl", "boot", "udid-1"],
      signal: expect.any(AbortSignal),
      timeoutMs: 30_000,
    });
    expect(commands.run).toHaveBeenNthCalledWith(2, {
      executable: "xcrun",
      args: ["simctl", "bootstatus", "udid-1", "-b"],
      signal: expect.any(AbortSignal),
      timeoutMs: 120_000,
    });
    expect(commands.run).toHaveBeenNthCalledWith(3, {
      executable: "xcrun",
      args: [
        "simctl",
        "get_app_container",
        "udid-1",
        "com.facebook.WebDriverAgentRunner.xctrunner",
        "app",
      ],
      timeoutMs: 5_000,
    });
    expect(automation.open).toHaveBeenCalledWith({
      udid: "udid-1",
      signal: expect.any(AbortSignal),
      usePreinstalledWda: true,
      onExit,
    });
    expect(target).toEqual({ platform: "ios", udid: "udid-1" });
  });

  it("uses the cold WDA build path when the device has no installed runner", async () => {
    const { adapter, commands, automation } = fixture();
    vi.mocked(commands.run).mockImplementation(async ({ args }) => {
      if (args.includes("get_app_container")) throw new Error("application not found");
      return { stdout: new Uint8Array(), stderr: new Uint8Array() };
    });

    await adapter.open({
      device: {
        id: "udid-1",
        platform: "ios",
        runtimeId: "runtime",
        deviceTypeId: "type",
        formFactor: "phone",
        name: "iPhone",
        state: "stopped",
        lastError: null,
      },
      signal: new AbortController().signal,
      onPhase: vi.fn(),
      onExit: vi.fn(),
    });

    expect(automation.open).toHaveBeenCalledWith(
      expect.objectContaining({ usePreinstalledWda: false }),
    );
  });

  it("closes automation and shuts down CoreSimulator when startup fails", async () => {
    const { adapter, commands, automation } = fixture();
    vi.mocked(automation.open).mockRejectedValueOnce(new Error("WDA timed out"));

    await expect(
      adapter.open({
        device: {
          id: "udid-1",
          platform: "ios",
          runtimeId: "runtime",
          deviceTypeId: "type",
          formFactor: "phone",
          name: "iPhone",
          state: "stopped",
          lastError: null,
        },
        signal: new AbortController().signal,
        onPhase: vi.fn(),
        onExit: vi.fn(),
      }),
    ).rejects.toThrow("WDA timed out");

    expect(automation.close).toHaveBeenCalledWith("udid-1");
    expect(commands.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ["simctl", "shutdown", "udid-1"] }),
    );
  });

  it("captures PNG bytes through simctl while routing input through automation", async () => {
    const { adapter, automation } = fixture();
    const device = {
      id: "udid-1",
      platform: "ios" as const,
      runtimeId: "runtime",
      deviceTypeId: "type",
      formFactor: "phone" as const,
      name: "iPhone",
      state: "ready" as const,
      lastError: null,
    };

    await expect(adapter.capture(device)).resolves.toEqual({
      dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
    });
    await adapter.tap(device, { x: 0.25, y: 0.75 });
    expect(automation.tap).toHaveBeenCalledWith("udid-1", { x: 0.25, y: 0.75 });
  });
});

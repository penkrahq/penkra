import { describe, expect, it, vi } from "vitest";

import {
  DesktopSimulatorManager,
  type SimulatorAdapter,
  type SimulatorOwner,
} from "./simulatorManager";

function fakeAdapter(overrides: Partial<SimulatorAdapter> = {}): SimulatorAdapter {
  return {
    platform: "android",
    availability: vi.fn(
      async () =>
        ({
          platform: "android",
          supported: true,
          status: "available",
          message: null,
        }) as const,
    ),
    listRuntimes: vi.fn(async () => [
      {
        id: "android-36",
        platform: "android",
        name: "Android 36",
        version: "36",
        status: "available",
        installable: true,
        message: null,
      } as const,
    ]),
    listDeviceTypes: vi.fn(async () => [
      {
        id: "pixel-8",
        platform: "android",
        runtimeId: "android-36",
        formFactor: "phone",
        name: "Pixel 8",
      } as const,
    ]),
    createDevice: vi.fn(
      async () =>
        ({
          id: "device-1",
          platform: "android",
          runtimeId: "android-36",
          deviceTypeId: "pixel-8",
          formFactor: "phone",
          name: "Pixel 8",
          state: "stopped",
          lastError: null,
        }) as const,
    ),
    eraseDevice: vi.fn(async (device) => ({
      ...device,
      state: "stopped",
      lastError: null,
    })),
    deleteDevice: vi.fn(async () => undefined),
    requestSetup: vi.fn(async () => undefined),
    open: vi.fn(async ({ onPhase }) => {
      onPhase("booting");
      return { platform: "android", serial: "emulator-5554" } as const;
    }),
    close: vi.fn(async () => undefined),
    capture: vi.fn(async () => ({ dataUrl: "data:image/png;base64,AA==" })),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    rotate: vi.fn(async () => undefined),
    ...overrides,
  };
}

const ownerA: SimulatorOwner = {
  appId: "com.penkra.simulator",
  spaceId: "space-a",
  tabId: "tab-a",
};
const ownerB: SimulatorOwner = {
  appId: "com.penkra.simulator",
  spaceId: "space-a",
  tabId: "tab-b",
};

async function managerWithDevice(adapter = fakeAdapter()) {
  const manager = new DesktopSimulatorManager([adapter]);
  const device = await manager.createDevice(ownerA, {
    runtimeId: "android-36",
    deviceTypeId: "pixel-8",
  });
  return { manager, adapter, device };
}

describe("DesktopSimulatorManager", () => {
  it("owns cancellable runtime setup by App, Space, and tab", async () => {
    const requestSetup = vi.fn(
      async (_runtimeId: string | undefined, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { code: "SETUP_CANCELLED" })),
            { once: true },
          );
        }),
    );
    const manager = new DesktopSimulatorManager([fakeAdapter({ requestSetup })]);
    const setup = manager.requestSetup(ownerA, {
      platform: "android",
      runtimeId: "android-36",
    });
    await vi.waitFor(() => expect(requestSetup).toHaveBeenCalledOnce());

    manager.cancelSetup(ownerB);
    expect(requestSetup.mock.calls[0]?.[1].aborted).toBe(false);
    manager.cancelSetup(ownerA);
    await expect(setup).rejects.toMatchObject({ code: "SETUP_CANCELLED" });
    expect(requestSetup.mock.calls[0]?.[0]).toBe("android-36");
  });

  it("cancels an owned runtime installer when its tab closes", async () => {
    const requestSetup = vi.fn(
      async (_runtimeId: string | undefined, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
        }),
    );
    const manager = new DesktopSimulatorManager([fakeAdapter({ requestSetup })]);
    const setup = manager.requestSetup(ownerA, {
      platform: "android",
      runtimeId: "android-36",
    });
    await vi.waitFor(() => expect(requestSetup).toHaveBeenCalledOnce());

    await manager.closeTab(ownerA.tabId);
    await expect(setup).rejects.toThrow("closed");
    expect(requestSetup.mock.calls[0]?.[1].aborted).toBe(true);
  });

  it("restores saved definitions as stopped without reviving transient host state", () => {
    const manager = new DesktopSimulatorManager([fakeAdapter()], {
      initialDevices: [
        {
          id: "restored",
          platform: "android",
          runtimeId: "android-36",
          deviceTypeId: "pixel-8",
          formFactor: "phone",
          name: "Restored Pixel",
          appId: ownerA.appId,
          spaceId: ownerA.spaceId,
        },
      ],
    });

    expect(manager.listDevices(ownerA)).toEqual([
      expect.objectContaining({
        id: "restored",
        state: "stopped",
        lastError: null,
      }),
    ]);
    expect(manager.getState(ownerA)).toMatchObject({
      open: false,
      phase: "closed",
    });
  });

  it("persists owned definitions and rolls back an uncommitted mutation", async () => {
    const persisted: unknown[] = [];
    const manager = new DesktopSimulatorManager([fakeAdapter()], {
      persistDevices: async (devices) => {
        persisted.push(devices);
      },
    });

    await manager.createDevice(ownerA, {
      runtimeId: "android-36",
      deviceTypeId: "pixel-8",
    });

    expect(persisted).toEqual([
      [
        expect.objectContaining({
          id: "device-1",
          appId: ownerA.appId,
          spaceId: ownerA.spaceId,
        }),
      ],
    ]);
    expect(JSON.stringify(persisted)).not.toContain("state");

    const failingAdapter = fakeAdapter();
    const failing = new DesktopSimulatorManager([failingAdapter], {
      persistDevices: async () => Promise.reject(new Error("disk full")),
    });
    await expect(
      failing.createDevice(ownerA, {
        runtimeId: "android-36",
        deviceTypeId: "pixel-8",
      }),
    ).rejects.toThrow("disk full");
    expect(failing.listDevices(ownerA)).toEqual([]);
    expect(failingAdapter.deleteDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: "device-1" }),
    );
  });

  it("scopes saved devices to one App and Space without returning ownership metadata", async () => {
    const { manager, device } = await managerWithDevice();

    expect(manager.listDevices(ownerA)).toEqual([device]);
    expect(manager.listDevices({ ...ownerA, spaceId: "space-b" })).toEqual([]);
    expect(device).not.toHaveProperty("appId");
    expect(device).not.toHaveProperty("spaceId");
  });

  it("emits lifecycle states and returns only a standard platform target", async () => {
    const { manager, device } = await managerWithDevice();
    const listener = vi.fn();
    manager.subscribe(listener);

    const state = await manager.open(ownerA, device.id);

    expect(listener.mock.calls.map((call) => call[1].phase)).toEqual([
      "preparing",
      "booting",
      "ready",
    ]);
    expect(state.target).toEqual({
      platform: "android",
      serial: "emulator-5554",
    });
    expect(state).not.toHaveProperty("port");
    expect(state).not.toHaveProperty("processId");
  });

  it("enforces one exclusive live lease for a saved device", async () => {
    const { manager, device } = await managerWithDevice();
    await manager.open(ownerA, device.id);

    await expect(manager.open(ownerB, device.id)).rejects.toMatchObject({
      code: "DEVICE_BUSY",
    });
  });

  it("releases the complete live lease on tab close while retaining the saved device", async () => {
    const adapter = fakeAdapter();
    const { manager, device } = await managerWithDevice(adapter);
    const listener = vi.fn();
    manager.subscribe(listener);
    await manager.open(ownerA, device.id);

    await manager.close(ownerA);

    expect(adapter.close).toHaveBeenCalledOnce();
    expect(manager.getState(ownerA)).toMatchObject({
      open: false,
      phase: "closed",
    });
    expect(manager.listDevices(ownerA)).toMatchObject([{ id: device.id, state: "stopped" }]);
    expect(listener.mock.calls.slice(-2).map((call) => call[1].phase)).toEqual([
      "stopping",
      "closed",
    ]);
    await expect(manager.open(ownerB, device.id)).resolves.toMatchObject({
      phase: "ready",
    });
  });

  it("preserves failed live ownership when adapter cleanup rejects, then settles a retry", async () => {
    const cleanupFailure = Object.assign(new Error("Native process remains live."), {
      code: "NATIVE_CLEANUP_FAILED",
    });
    const close = vi
      .fn<SimulatorAdapter["close"]>()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined);
    const adapter = fakeAdapter({ close });
    const { manager, device } = await managerWithDevice(adapter);
    const listener = vi.fn();
    manager.subscribe(listener);
    await manager.open(ownerA, device.id);

    await expect(manager.close(ownerA)).rejects.toBe(cleanupFailure);

    expect(manager.getState(ownerA)).toMatchObject({
      open: true,
      phase: "failed",
      target: null,
      lastError: "Native process remains live.",
    });
    expect(manager.listDevices(ownerA)).toMatchObject([
      { id: device.id, state: "failed", lastError: "Native process remains live." },
    ]);
    expect(manager.diagnostics()).toMatchObject({
      liveSessionCount: 1,
      leasedDeviceCount: 1,
      sessions: [{ tabId: ownerA.tabId, deviceId: device.id, phase: "failed" }],
    });
    await expect(manager.open(ownerB, device.id)).rejects.toMatchObject({ code: "DEVICE_BUSY" });
    expect(listener.mock.calls.slice(-2).map((call) => call[1].phase)).toEqual([
      "stopping",
      "failed",
    ]);

    await expect(manager.close(ownerA)).resolves.toBeUndefined();
    expect(manager.getState(ownerA)).toMatchObject({ open: false, phase: "closed" });
    expect(manager.listDevices(ownerA)).toMatchObject([{ id: device.id, state: "stopped" }]);
    expect(manager.diagnostics()).toMatchObject({
      liveSessionCount: 0,
      leasedDeviceCount: 0,
      sessions: [],
    });
    expect(listener.mock.calls.slice(-2).map((call) => call[1].phase)).toEqual([
      "stopping",
      "closed",
    ]);
  });

  it("lets the trusted tab host close by tab ID without renderer ownership input", async () => {
    const adapter = fakeAdapter();
    const { manager, device } = await managerWithDevice(adapter);
    await manager.open(ownerA, device.id);

    await manager.closeTab(ownerA.tabId);

    expect(adapter.close).toHaveBeenCalledOnce();
    expect(manager.diagnostics()).toMatchObject({
      savedDeviceCount: 1,
      liveSessionCount: 0,
      leasedDeviceCount: 0,
      sessions: [],
    });
  });

  it("releases a failed startup lease and preserves an actionable failed state", async () => {
    const failure = Object.assign(new Error("Emulator boot failed."), {
      code: "BOOT_FAILED",
    });
    const adapter = fakeAdapter({
      open: vi.fn(async () => Promise.reject(failure)),
    });
    const { manager, device } = await managerWithDevice(adapter);

    await expect(manager.open(ownerA, device.id)).rejects.toBe(failure);
    expect(manager.getState(ownerA)).toMatchObject({
      open: true,
      phase: "failed",
      lastError: "Emulator boot failed.",
    });
    await expect(manager.open(ownerB, device.id)).rejects.toBe(failure);
  });

  it("releases the lease and publishes failure when a ready native session exits", async () => {
    let nativeExit: ((error: Error) => void) | undefined;
    const adapter = fakeAdapter({
      open: vi.fn(async ({ onExit }) => {
        nativeExit = onExit;
        return { platform: "android", serial: "emulator-5554" } as const;
      }),
    });
    const { manager, device } = await managerWithDevice(adapter);
    const listener = vi.fn();
    manager.subscribe(listener);
    await manager.open(ownerA, device.id);

    nativeExit?.(new Error("Emulator process exited unexpectedly."));

    expect(manager.getState(ownerA)).toMatchObject({
      phase: "failed",
      target: null,
      lastError: "Emulator process exited unexpectedly.",
    });
    expect(listener).toHaveBeenLastCalledWith(ownerA, expect.objectContaining({ phase: "failed" }));
    await expect(manager.open(ownerB, device.id)).resolves.toMatchObject({
      phase: "ready",
    });
  });

  it("validates normalized input before invoking a ready adapter", async () => {
    const adapter = fakeAdapter();
    const { manager, device } = await managerWithDevice(adapter);
    await manager.open(ownerA, device.id);

    await expect(manager.tap(ownerA, { x: 1.1, y: 0.5 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(adapter.tap).not.toHaveBeenCalled();
    await manager.tap(ownerA, { x: 0.5, y: 0.5 });
    expect(adapter.tap).toHaveBeenCalledWith(expect.objectContaining({ id: device.id }), {
      x: 0.5,
      y: 0.5,
    });
  });

  it("stops every owned session during host disposal", async () => {
    const adapter = fakeAdapter({
      createDevice: vi
        .fn()
        .mockResolvedValueOnce({
          id: "device-1",
          platform: "android",
          runtimeId: "android-36",
          deviceTypeId: "pixel-8",
          formFactor: "phone",
          name: "Pixel 8",
          state: "stopped",
          lastError: null,
        })
        .mockResolvedValueOnce({
          id: "device-2",
          platform: "android",
          runtimeId: "android-36",
          deviceTypeId: "pixel-8",
          formFactor: "phone",
          name: "Pixel 8 2",
          state: "stopped",
          lastError: null,
        }),
    });
    const manager = new DesktopSimulatorManager([adapter]);
    const first = await manager.createDevice(ownerA, {
      runtimeId: "android-36",
      deviceTypeId: "pixel-8",
    });
    const second = await manager.createDevice(ownerB, {
      runtimeId: "android-36",
      deviceTypeId: "pixel-8",
    });
    await manager.open(ownerA, first.id);
    await manager.open(ownerB, second.id);

    await manager.dispose();

    expect(adapter.close).toHaveBeenCalledTimes(2);
  });
});

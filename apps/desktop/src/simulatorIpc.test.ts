import { describe, expect, it, vi } from "vitest";

import { invokeSimulatorCall } from "./simulatorIpc";
import type { DesktopSimulatorManager, SimulatorOwner } from "./simulatorManager";

const owner: SimulatorOwner = {
  appId: "com.penkra.simulator",
  spaceId: "space-a",
  tabId: "tab-a",
};

function fixture() {
  const manager = {
    getEnvironment: vi.fn(async () => ({ platforms: [], runtimes: [] })),
    listRuntimes: vi.fn(async () => []),
    listDeviceTypes: vi.fn(async () => []),
    listDevices: vi.fn(() => []),
    createDevice: vi.fn(async () => ({ id: "device-1" })),
    eraseDevice: vi.fn(async () => ({ id: "device-1" })),
    deleteDevice: vi.fn(async () => undefined),
    requestSetup: vi.fn(async () => ({ platforms: [], runtimes: [] })),
    cancelSetup: vi.fn(),
    open: vi.fn(async () => ({ phase: "ready" })),
    close: vi.fn(async () => undefined),
    getState: vi.fn(() => ({ phase: "closed" })),
    getTarget: vi.fn(() => ({ platform: "android", serial: "emulator-5554" })),
    capture: vi.fn(async () => ({ dataUrl: "data:image/png;base64,AA==" })),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    rotate: vi.fn(async () => ({ orientation: "landscape" })),
  };
  const viewport = { setViewport: vi.fn(async () => undefined) };
  const authorizeSetup = vi.fn(async () => true);
  const invoke = (method: string, value?: unknown) =>
    invokeSimulatorCall({
      manager: manager as unknown as DesktopSimulatorManager,
      owner,
      method,
      value,
      viewport,
      authorizeSetup,
    });
  return { manager, viewport, authorizeSetup, invoke };
}

describe("invokeSimulatorCall", () => {
  it("requires trusted authorization and scopes setup cancellation to the tab", async () => {
    const { manager, authorizeSetup, invoke } = fixture();
    const request = { platform: "android", runtimeId: "android-36" } as const;

    await invoke("requestSetup", request);
    await invoke("cancelSetup");

    expect(authorizeSetup).toHaveBeenCalledWith(request);
    expect(manager.requestSetup).toHaveBeenCalledWith(owner, request);
    expect(manager.cancelSetup).toHaveBeenCalledWith(owner);
  });

  it("passes the host-asserted App, Space, and tab owner to scoped operations", async () => {
    const { manager, invoke } = fixture();

    await invoke("listDevices");
    await invoke("createDevice", {
      runtimeId: "android-36",
      deviceTypeId: "pixel-8",
      name: "Pixel 8",
      appId: "forged",
      spaceId: "forged",
    });

    expect(manager.listDevices).toHaveBeenCalledWith(owner);
    expect(manager.createDevice).toHaveBeenCalledWith(owner, {
      runtimeId: "android-36",
      deviceTypeId: "pixel-8",
      name: "Pixel 8",
    });
  });

  it("routes viewport ownership separately from lifecycle state", async () => {
    const { viewport, invoke } = fixture();

    await invoke("setViewport", { x: 10, y: 20, width: 500, height: 700 });
    await invoke("setViewport", null);

    expect(viewport.setViewport).toHaveBeenNthCalledWith(1, owner, {
      x: 10,
      y: 20,
      width: 500,
      height: 700,
    });
    expect(viewport.setViewport).toHaveBeenNthCalledWith(2, owner, null);
  });

  it("validates bounded input before any native manager call", async () => {
    const { manager, invoke } = fixture();

    await expect(invoke("tap", { x: 1.1, y: 0.5 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(invoke("press", "escape")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(invoke("type", "x".repeat(10_001))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    expect(manager.tap).not.toHaveBeenCalled();
    expect(manager.press).not.toHaveBeenCalled();
    expect(manager.type).not.toHaveBeenCalled();
  });

  it("rejects unknown bridge methods explicitly", async () => {
    const { invoke } = fixture();

    await expect(invoke("spawn", {})).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  });
});

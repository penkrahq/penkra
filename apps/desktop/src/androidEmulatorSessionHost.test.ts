import { describe, expect, it, vi } from "vitest";

import {
  DefaultAndroidEmulatorSessionHost,
  type AndroidEmulatorController,
  type AndroidEmulatorInstance,
} from "./androidEmulatorSessionHost";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const exited = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
  const instance: AndroidEmulatorInstance = {
    serial: "emulator-5554",
    endpoint: {
      target: "127.0.0.1:8554",
      token: "secret",
      protoPath: "/sdk/emulator/lib/emulator_controller.proto",
    },
    exited: exited.promise,
    stop: vi.fn(async () => undefined),
  };
  const controller: AndroidEmulatorController = {
    capture: vi.fn(async () => ({ dataUrl: "data:image/png;base64,frame" })),
    subscribeFrames: vi.fn(() => ({ stop: vi.fn() })),
    tap: vi.fn(async () => undefined),
    swipe: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    rotate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const launcher = { start: vi.fn(async () => instance), erase: vi.fn(async () => undefined) };
  const controllers = { connect: vi.fn(async () => controller) };
  const host = new DefaultAndroidEmulatorSessionHost({ launcher, controllers });
  return { host, launcher, controllers, controller, instance, exited };
}

describe("DefaultAndroidEmulatorSessionHost", () => {
  it("connects only after the authenticated endpoint is ready", async () => {
    const { host, launcher, controllers, instance } = fixture();
    const phases: string[] = [];
    const result = await host.open({
      avdName: "penkra-pixel-1",
      signal: new AbortController().signal,
      onPhase: (phase) => phases.push(phase),
      onExit: vi.fn(),
    });

    expect(result).toEqual({ serial: "emulator-5554" });
    expect(launcher.start).toHaveBeenCalledWith(
      expect.objectContaining({ avdName: "penkra-pixel-1" }),
    );
    expect(controllers.connect).toHaveBeenCalledWith(instance.endpoint, instance.serial);
    expect(host.diagnostics().liveAvdNames).toEqual(["penkra-pixel-1"]);
  });

  it("tears the emulator down if controller connection fails", async () => {
    const { host, controllers, instance } = fixture();
    vi.mocked(controllers.connect).mockRejectedValueOnce(new Error("endpoint unavailable"));

    await expect(
      host.open({
        avdName: "penkra-pixel-1",
        signal: new AbortController().signal,
        onPhase: () => undefined,
        onExit: vi.fn(),
      }),
    ).rejects.toThrow("endpoint unavailable");
    expect(instance.stop).toHaveBeenCalledOnce();
    expect(host.diagnostics().liveAvdNames).toEqual([]);
  });

  it("closes controller and native instance even when one cleanup step fails", async () => {
    const { host, controller, instance } = fixture();
    await host.open({
      avdName: "penkra-pixel-1",
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onExit: vi.fn(),
    });
    vi.mocked(controller.close).mockRejectedValueOnce(new Error("grpc close failed"));

    await expect(host.close("penkra-pixel-1")).rejects.toMatchObject({
      code: "SESSION_CLEANUP_FAILED",
    });
    expect(instance.stop).toHaveBeenCalledOnce();
    expect(host.diagnostics().liveAvdNames).toEqual([]);
  });

  it("drops controller authority after an unexpected emulator exit", async () => {
    const { host, controller, exited } = fixture();
    const onExit = vi.fn();
    await host.open({
      avdName: "penkra-pixel-1",
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onExit,
    });
    exited.resolve({ exitCode: 1, signal: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.close).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ code: "NATIVE_SESSION_EXITED" }));
    expect(host.diagnostics().liveAvdNames).toEqual([]);
    await expect(host.capture("penkra-pixel-1")).rejects.toMatchObject({
      code: "SESSION_NOT_READY",
    });
  });

  it("forwards frame and input operations only to a live session", async () => {
    const { host, controller } = fixture();
    await host.open({
      avdName: "penkra-pixel-1",
      signal: new AbortController().signal,
      onPhase: () => undefined,
      onExit: vi.fn(),
    });

    await expect(host.capture("penkra-pixel-1")).resolves.toEqual({
      dataUrl: "data:image/png;base64,frame",
    });
    await host.tap("penkra-pixel-1", { x: 0.4, y: 0.6 });
    await host.type("penkra-pixel-1", "hello");
    expect(controller.tap).toHaveBeenCalledWith({ x: 0.4, y: 0.6 });
    expect(controller.type).toHaveBeenCalledWith("hello");
  });
});

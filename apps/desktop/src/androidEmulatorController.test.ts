import { describe, expect, it, vi } from "vitest";

import { GrpcAndroidEmulatorController } from "./androidEmulatorController";

function fixture() {
  const calls: Array<{ method: string; request: unknown; authorization: unknown }> = [];
  const streamListeners = new Map<string, (value?: unknown) => void>();
  const stream = {
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      streamListeners.set(event, listener);
      return stream;
    }),
    cancel: vi.fn(),
  };
  const client = {
    close: vi.fn(),
    getScreenshot(
      request: unknown,
      metadata: { get(key: string): unknown },
      callback: (error: null, response: unknown) => void,
    ) {
      calls.push({
        method: "getScreenshot",
        request,
        authorization: metadata.get("authorization"),
      });
      callback(null, { image: Buffer.from("png"), format: { width: 400, height: 800 } });
    },
    sendTouch(
      request: unknown,
      metadata: { get(key: string): unknown },
      callback: (error: null, response: unknown) => void,
    ) {
      calls.push({ method: "sendTouch", request, authorization: metadata.get("authorization") });
      callback(null, {});
    },
    sendKey(
      request: unknown,
      metadata: { get(key: string): unknown },
      callback: (error: null, response: unknown) => void,
    ) {
      calls.push({ method: "sendKey", request, authorization: metadata.get("authorization") });
      callback(null, {});
    },
    streamScreenshot(request: unknown, metadata: { get(key: string): unknown }) {
      calls.push({
        method: "streamScreenshot",
        request,
        authorization: metadata.get("authorization"),
      });
      return stream;
    },
  };
  const commands = {
    run: vi.fn(async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array() })),
  };
  const controller = new GrpcAndroidEmulatorController({
    client,
    token: "private-token",
    serial: "emulator-5554",
    adb: "/sdk/platform-tools/adb",
    commands,
  });
  return { controller, client, commands, calls, stream, streamListeners };
}

describe("GrpcAndroidEmulatorController", () => {
  it("captures PNG frames and attaches the private bearer token to RPCs", async () => {
    const { controller, calls } = fixture();
    await expect(controller.capture()).resolves.toEqual({
      dataUrl: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
    });
    expect(calls[0]).toMatchObject({
      method: "getScreenshot",
      request: { format: "PNG" },
      authorization: ["Bearer private-token"],
    });
  });

  it("uses the SDK server stream for continuous PNG frames and cancels it", () => {
    const { controller, calls, stream, streamListeners } = fixture();
    const onFrame = vi.fn();
    const subscription = controller.subscribeFrames(onFrame, vi.fn());
    streamListeners.get("data")?.({
      image: Buffer.from("frame"),
      format: { width: 400, height: 800 },
    });
    expect(calls[0]).toMatchObject({
      method: "streamScreenshot",
      request: { format: "PNG", display: 0 },
      authorization: ["Bearer private-token"],
    });
    expect(onFrame).toHaveBeenCalledWith({
      mimeType: "image/png",
      data: new Uint8Array(Buffer.from("frame")),
    });
    subscription.stop();
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("maps normalized coordinates to native pixels and releases touch pressure", async () => {
    const { controller, calls } = fixture();
    await controller.tap({ x: 0.5, y: 0.25 });
    const touchCalls = calls.filter((call) => call.method === "sendTouch");
    expect(touchCalls.map((call) => call.request)).toEqual([
      { touches: [{ x: 200, y: 200, identifier: 0, pressure: 1 }], display: 0 },
      { touches: [{ x: 200, y: 200, identifier: 0, pressure: 0 }], display: 0 },
    ]);
  });

  it("uses serial-scoped Android key events for hardware controls", async () => {
    const { controller, commands } = fixture();
    await controller.press("home");
    await controller.press("app-switcher");
    expect(commands.run).toHaveBeenNthCalledWith(1, {
      executable: "/sdk/platform-tools/adb",
      args: ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_HOME"],
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
    });
    expect(commands.run).toHaveBeenNthCalledWith(2, {
      executable: "/sdk/platform-tools/adb",
      args: ["-s", "emulator-5554", "shell", "input", "keyevent", "KEYCODE_APP_SWITCH"],
      timeoutMs: 10_000,
      maxOutputBytes: 4_096,
    });
  });

  it("rotates through the standard ADB target and invalidates frame geometry", async () => {
    const { controller, commands } = fixture();
    await controller.rotate("landscape");
    expect(commands.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: [
          "-s",
          "emulator-5554",
          "shell",
          "settings",
          "put",
          "system",
          "accelerometer_rotation",
          "0",
        ],
      }),
    );
    expect(commands.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: ["-s", "emulator-5554", "shell", "settings", "put", "system", "user_rotation", "1"],
      }),
    );
  });

  it("closes the gRPC client exactly once", async () => {
    const { controller, client } = fixture();
    await controller.close();
    await controller.close();
    expect(client.close).toHaveBeenCalledOnce();
    await expect(controller.type("hello")).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
  });
});

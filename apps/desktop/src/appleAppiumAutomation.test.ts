import { describe, expect, it, vi } from "vitest";

import { AppiumAppleSimulatorAutomation } from "./appleAppiumAutomation";

function fixture() {
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    () => undefined,
  );
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const request = vi.fn(
    async (input: { method: "GET" | "POST" | "DELETE"; url: string; body?: unknown }) => {
      calls.push(input);
      if (input.url.endsWith("/session") && input.method === "POST") {
        return { value: { sessionId: "session-1", capabilities: {} } };
      }
      if (input.url.endsWith("/window/rect"))
        return { value: { x: 0, y: 0, width: 400, height: 800 } };
      return { value: null };
    },
  );
  const ports = [8101, 9101];
  const automation = new AppiumAppleSimulatorAutomation({
    server: { baseUrl: "http://127.0.0.1:4723", exited, stop: async () => undefined },
    request,
    allocatePort: async () => ports.shift()!,
  });
  return { automation, request, calls };
}

describe("AppiumAppleSimulatorAutomation", () => {
  it("creates a loopback XCUITest session with unique WDA and MJPEG ports", async () => {
    const { automation, calls } = fixture();
    await automation.open({
      udid: "udid-1",
      signal: new AbortController().signal,
      usePreinstalledWda: true,
      onExit: vi.fn(),
    });

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:4723/session",
      body: {
        capabilities: {
          alwaysMatch: {
            platformName: "iOS",
            "appium:automationName": "XCUITest",
            "appium:udid": "udid-1",
            "appium:newCommandTimeout": 0,
            "appium:isHeadless": true,
            "appium:wdaLocalPort": 8101,
            "appium:wdaBindingIP": "127.0.0.1",
            "appium:mjpegServerPort": 9101,
            "appium:derivedDataPath": expect.stringContaining("udid-1"),
            "appium:wdaLaunchTimeout": 180_000,
            "appium:usePreinstalledWDA": true,
          },
        },
      },
    });
    expect(automation.mjpegUrl("udid-1")).toBe("http://127.0.0.1:9101");
  });

  it("retains independent concurrent sessions", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    let sessionNumber = 0;
    const request = vi.fn(async () => {
      sessionNumber += 1;
      if (sessionNumber === 1) return first;
      return { value: { sessionId: "session-2" } };
    });
    const ports = [8101, 9101, 8102, 9102];
    const automation = new AppiumAppleSimulatorAutomation({
      server: {
        baseUrl: "http://127.0.0.1:4723",
        exited: new Promise(() => undefined),
        stop: async () => undefined,
      },
      request,
      allocatePort: async () => ports.shift()!,
    });

    const firstOpen = automation.open({
      udid: "udid-1",
      signal: new AbortController().signal,
      onExit: vi.fn(),
    });
    const secondOpen = automation.open({
      udid: "udid-2",
      signal: new AbortController().signal,
      onExit: vi.fn(),
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    resolveFirst({ value: { sessionId: "session-1" } });
    await Promise.all([firstOpen, secondOpen]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(automation.mjpegUrl("udid-1")).toBe("http://127.0.0.1:9101");
    expect(automation.mjpegUrl("udid-2")).toBe("http://127.0.0.1:9102");
  });

  it("maps normalized pointer input through W3C touch actions", async () => {
    const { automation, calls } = fixture();
    await automation.open({
      udid: "udid-1",
      signal: new AbortController().signal,
      onExit: vi.fn(),
    });
    await automation.tap("udid-1", { x: 0.5, y: 0.25 });

    expect(calls.at(-1)).toMatchObject({
      url: "http://127.0.0.1:4723/session/session-1/actions",
      body: {
        actions: [
          {
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", x: 200, y: 200 },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      },
    });
  });

  it("deletes the WDA session on close and rejects input afterward", async () => {
    const { automation, calls } = fixture();
    await automation.open({
      udid: "udid-1",
      signal: new AbortController().signal,
      onExit: vi.fn(),
    });
    await automation.close("udid-1");
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "http://127.0.0.1:4723/session/session-1",
    });
    await expect(automation.type("udid-1", "hello")).rejects.toMatchObject({
      code: "SESSION_NOT_READY",
    });
  });

  it("bounds a stalled session delete so tab cleanup can stop Appium", async () => {
    const request = vi.fn(({ method, signal }: { method: string; signal?: AbortSignal }) => {
      if (method === "POST") {
        return Promise.resolve({ value: { sessionId: "session-1" } });
      }
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const automation = new AppiumAppleSimulatorAutomation({
      server: {
        baseUrl: "http://127.0.0.1:4723",
        exited: new Promise(() => undefined),
        stop: async () => undefined,
      },
      request,
      allocatePort: async () => 8101,
      sessionDeleteTimeoutMs: 5,
    });
    await automation.open({
      udid: "udid-1",
      signal: new AbortController().signal,
      onExit: vi.fn(),
    });

    await expect(automation.close("udid-1")).rejects.toBeInstanceOf(Error);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    );
  });

  it("reports non-universal iOS navigation buttons explicitly", async () => {
    const { automation } = fixture();
    await automation.open({
      udid: "udid-1",
      signal: new AbortController().signal,
      onExit: vi.fn(),
    });
    await expect(automation.press("udid-1", "back")).rejects.toMatchObject({
      code: "BUTTON_UNSUPPORTED",
    });
  });

  it("stops Appium when the bounded session-start request expires", async () => {
    const stop = vi.fn(async () => undefined);
    const request = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const automation = new AppiumAppleSimulatorAutomation({
      server: {
        baseUrl: "http://127.0.0.1:4723",
        exited: new Promise(() => undefined),
        stop,
      },
      request,
      allocatePort: async () => 8101,
      sessionStartTimeoutMs: 5,
    });

    await expect(
      automation.open({
        udid: "udid-1",
        signal: new AbortController().signal,
        onExit: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "APPIUM_SESSION_TIMEOUT" });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("composes caller cancellation with the session-start timeout", async () => {
    const stop = vi.fn(async () => undefined);
    const request = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const automation = new AppiumAppleSimulatorAutomation({
      server: {
        baseUrl: "http://127.0.0.1:4723",
        exited: new Promise(() => undefined),
        stop,
      },
      request,
      allocatePort: async () => 8101,
      sessionStartTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const opened = automation.open({
      udid: "udid-1",
      signal: controller.signal,
      onExit: vi.fn(),
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort();

    await expect(opened).rejects.toMatchObject({ code: "SESSION_CANCELLED" });
    expect(stop).toHaveBeenCalledOnce();
  });
});

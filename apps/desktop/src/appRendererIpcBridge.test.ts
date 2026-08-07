import { describe, expect, it, vi } from "vitest";

import { AppRendererIpcBridge } from "./appRendererIpcBridge";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";

function fixture() {
  const listeners = new Map<string, Set<(event: unknown, message?: unknown) => void>>();
  const ipcMain = {
    on: vi.fn((channel: string, listener: (event: unknown, message?: unknown) => void) => {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return ipcMain;
    }),
    removeListener: vi.fn((channel: string, listener: (event: unknown) => void) => {
      listeners.get(channel)?.delete(listener);
      return ipcMain;
    }),
  };
  const rpc = {
    acceptResponse: vi.fn(() => true),
    acceptContextCall: vi.fn(() => true),
  };
  const invalid = vi.fn();
  const bridge = new AppRendererIpcBridge({
    ipcMain: ipcMain as never,
    rpc,
    readyTimeoutMs: 100,
    onInvalidMessage: invalid,
  });
  const emit = (channel: string, senderId: number, message?: unknown) => {
    for (const listener of listeners.get(channel) ?? []) {
      listener({ sender: { id: senderId } }, message);
    }
  };
  return { bridge, rpc, invalid, emit, listeners };
}

describe("AppRendererIpcBridge", () => {
  it("routes responses and context calls using Electron's sender identity", () => {
    const test = fixture();
    test.bridge.start();
    test.bridge.start();
    test.emit(APP_RUNTIME_IPC_CHANNELS.rendererMessage, 42, {
      type: "result",
      id: "request-1",
      result: {},
    });
    test.emit(APP_RUNTIME_IPC_CHANNELS.rendererMessage, 42, {
      type: "context-call",
      parentId: "request-1",
      id: "context-1",
      method: "context.tabs.open",
      input: {},
    });

    expect(test.rpc.acceptResponse).toHaveBeenCalledWith(42, expect.any(Object));
    expect(test.rpc.acceptContextCall).toHaveBeenCalledWith(42, expect.any(Object));
    expect(test.listeners.get(APP_RUNTIME_IPC_CHANNELS.rendererMessage)).toHaveLength(1);
  });

  it("waits for readiness from only the expected renderer", async () => {
    const test = fixture();
    test.bridge.start();
    const ready = test.bridge.waitForReady(42);
    test.emit(APP_RUNTIME_IPC_CHANNELS.ready, 41);
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    test.emit(APP_RUNTIME_IPC_CHANNELS.ready, 42);
    await expect(ready).resolves.toBeUndefined();
  });

  it("remembers readiness reported before its waiter is registered", async () => {
    const test = fixture();
    test.bridge.start();
    test.emit(APP_RUNTIME_IPC_CHANNELS.ready, 42);

    await expect(test.bridge.waitForReady(42)).resolves.toBeUndefined();

    const nextNavigation = test.bridge.waitForReady(42);
    test.emit(APP_RUNTIME_IPC_CHANNELS.ready, 42);
    await expect(nextNavigation).resolves.toBeUndefined();
  });

  it("rejects readiness on abort, timeout, and bridge disposal", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture();
      test.bridge.start();
      const controller = new AbortController();
      const aborted = test.bridge.waitForReady(1, controller.signal);
      const abortedExpectation = expect(aborted).rejects.toThrow("cancelled");
      controller.abort(new Error("cancelled"));
      await abortedExpectation;

      const timedOut = test.bridge.waitForReady(2);
      const timeoutExpectation = expect(timedOut).rejects.toThrow("did not become ready");
      await vi.advanceTimersByTimeAsync(100);
      await timeoutExpectation;

      const disposed = test.bridge.waitForReady(3);
      const disposedExpectation = expect(disposed).rejects.toThrow("bridge stopped");
      test.bridge.dispose();
      await disposedExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports malformed App messages without throwing through Electron", () => {
    const test = fixture();
    test.bridge.start();
    expect(() =>
      test.emit(APP_RUNTIME_IPC_CHANNELS.rendererMessage, 42, { type: "raw-ipc-escape" }),
    ).not.toThrow();
    expect(test.invalid).toHaveBeenCalledWith(expect.any(Error), 42);
  });
});

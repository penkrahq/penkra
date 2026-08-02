import { describe, expect, it, vi } from "vitest";

import { AppRendererRpcError, AppRendererRpcHost } from "./appRendererRpc";

function fixture(options: ConstructorParameters<typeof AppRendererRpcHost>[0] = {}) {
  const sent: unknown[] = [];
  const host = new AppRendererRpcHost({
    defaultTimeoutMs: 1_000,
    mintRequestId: () => "request-1",
    ...options,
  });
  const unregister = host.registerTarget({ id: 17, send: (message) => sent.push(message) });
  return { host, sent, unregister };
}

describe("AppRendererRpcHost", () => {
  it("resolves only a response from the exact target renderer", async () => {
    const test = fixture();
    const result = test.host.request(17, "controller.invoke", { operation: "issues.create" });
    expect(test.sent).toEqual([
      {
        type: "request",
        id: "request-1",
        method: "controller.invoke",
        input: { operation: "issues.create" },
      },
    ]);

    expect(
      test.host.acceptResponse(18, { type: "result", id: "request-1", result: { forged: true } }),
    ).toBe(false);
    expect(
      test.host.acceptResponse(17, { type: "result", id: "request-1", result: { id: "PEN-1" } }),
    ).toBe(true);
    await expect(result).resolves.toEqual({ id: "PEN-1" });
  });

  it("maps a renderer error without trusting it as a host error code", async () => {
    const test = fixture();
    const result = test.host.request(17, "tab.invoke", {});
    test.host.acceptResponse(17, {
      type: "error",
      id: "request-1",
      code: "TAB_REQUIRED",
      message: "Select a tab.",
    });
    await expect(result).rejects.toMatchObject<AppRendererRpcError>({
      code: "renderer-error",
      rendererCode: "TAB_REQUIRED",
      message: "Select a tab.",
    });
  });

  it("cancels pending work when its target unregisters", async () => {
    const test = fixture();
    const result = test.host.request(17, "tab.navigate-for-result", {});
    test.unregister();

    expect(test.sent.at(-1)).toEqual({
      type: "cancel",
      id: "request-1",
      reason: "tab-closed",
    });
    await expect(result).rejects.toMatchObject({ code: "renderer-unavailable" });
    expect(
      test.host.acceptResponse(17, { type: "result", id: "request-1", result: {} }),
    ).toBe(false);
  });

  it("propagates caller abort and ignores a late result", async () => {
    const test = fixture();
    const controller = new AbortController();
    const result = test.host.request(17, "controller.invoke", {}, { signal: controller.signal });
    controller.abort(new Error("operation disabled"));

    expect(test.sent.at(-1)).toEqual({
      type: "cancel",
      id: "request-1",
      reason: "operation-cancelled",
    });
    await expect(result).rejects.toThrow("operation disabled");
    expect(
      test.host.acceptResponse(17, { type: "result", id: "request-1", result: {} }),
    ).toBe(false);
  });

  it("times out, tells the renderer to cancel, and releases target capacity", async () => {
    vi.useFakeTimers();
    try {
      let nextId = 0;
      const test = fixture({ defaultTimeoutMs: 50, mintRequestId: () => `request-${++nextId}` });
      const result = test.host.request(17, "controller.invoke", {});
      const rejection = expect(result).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(50);

      expect(test.sent.at(-1)).toEqual({
        type: "cancel",
        id: "request-1",
        reason: "timeout",
      });
      await rejection;
      const next = test.host.request(17, "controller.invoke", {});
      test.host.acceptResponse(17, { type: "result", id: "request-2", result: "ok" });
      await expect(next).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces per-target backpressure and JSON payload bounds", async () => {
    let nextId = 0;
    const test = fixture({
      maxPendingPerTarget: 1,
      maxPayloadBytes: 32,
      mintRequestId: () => `request-${++nextId}`,
    });
    const pending = test.host.request(17, "controller.invoke", { ok: true });
    await expect(test.host.request(17, "controller.invoke", { second: true })).rejects.toMatchObject(
      { code: "target-overloaded" },
    );
    test.host.acceptResponse(17, { type: "result", id: "request-1", result: null });
    await pending;

    await expect(
      test.host.request(17, "controller.invoke", { content: "x".repeat(64) }),
    ).rejects.toMatchObject({ code: "payload-too-large" });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(test.host.request(17, "controller.invoke", cycle)).rejects.toMatchObject({
      code: "invalid-message",
    });
    await expect(
      test.host.request(17, "controller.invoke", { missing: undefined }),
    ).rejects.toMatchObject({ code: "invalid-message" });
    await expect(
      test.host.request(17, "controller.invoke", { progress: Number.NaN }),
    ).rejects.toMatchObject({ code: "invalid-message" });
  });

  it("rejects malformed renderer responses without settling valid pending work", async () => {
    const test = fixture();
    const result = test.host.request(17, "controller.invoke", {});
    expect(() =>
      test.host.acceptResponse(17, { type: "error", id: "request-1", code: 4, message: "bad" }),
    ).toThrowError(expect.objectContaining({ code: "invalid-message" }));

    test.host.acceptResponse(17, { type: "result", id: "request-1", result: "valid" });
    await expect(result).resolves.toBe("valid");
  });

  it("stops all targets and rejects future work", async () => {
    const test = fixture();
    const result = test.host.request(17, "controller.invoke", {});
    test.host.stop();
    await expect(result).rejects.toMatchObject({ code: "host-stopped" });
    await expect(test.host.request(17, "controller.invoke", {})).rejects.toMatchObject({
      code: "host-stopped",
    });
  });

  it("binds renderer context calls to their exact parent request and target", async () => {
    const test = fixture();
    const handleContextCall = vi.fn(async (method, input) => ({ method, input }));
    const result = test.host.request(
      17,
      "controller.invoke",
      {},
      { handleContextCall },
    );

    expect(
      test.host.acceptContextCall(18, {
        type: "context-call",
        parentId: "request-1",
        id: "context-1",
        method: "context.tabs.open",
        input: { route: "/issues/new" },
      }),
    ).toBe(false);
    expect(
      test.host.acceptContextCall(17, {
        type: "context-call",
        parentId: "request-1",
        id: "context-1",
        method: "context.tabs.open",
        input: { route: "/issues/new" },
      }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(test.sent).toContainEqual({
        type: "context-result",
        parentId: "request-1",
        id: "context-1",
        result: {
          method: "context.tabs.open",
          input: { route: "/issues/new" },
        },
      });
    });
    test.host.acceptResponse(17, { type: "result", id: "request-1", result: "done" });
    await expect(result).resolves.toBe("done");
  });

  it("aborts active context calls when the parent request settles", async () => {
    const test = fixture();
    let contextSignal: AbortSignal | undefined;
    const handleContextCall = vi.fn(
      async (_method, _input, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          contextSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const result = test.host.request(17, "controller.invoke", {}, { handleContextCall });
    test.host.acceptContextCall(17, {
      type: "context-call",
      parentId: "request-1",
      id: "context-1",
      method: "context.tab.invoke",
      input: {},
    });

    test.host.acceptResponse(17, { type: "result", id: "request-1", result: "done" });
    await expect(result).resolves.toBe("done");
    expect(contextSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(test.sent.some((message) => (message as { type?: string }).type === "context-error"))
      .toBe(false);
  });

  it("returns scoped context errors instead of settling the parent request", async () => {
    const test = fixture();
    const error = Object.assign(new Error("Choose an issue tab."), { code: "TAB_REQUIRED" });
    const result = test.host.request(17, "controller.invoke", {}, {
      handleContextCall: async () => {
        throw error;
      },
    });
    test.host.acceptContextCall(17, {
      type: "context-call",
      parentId: "request-1",
      id: "context-1",
      method: "context.tab.navigate",
      input: { route: "/issues/new" },
    });

    await vi.waitFor(() => {
      expect(test.sent).toContainEqual({
        type: "context-error",
        parentId: "request-1",
        id: "context-1",
        code: "TAB_REQUIRED",
        message: "Choose an issue tab.",
      });
    });
    test.host.acceptResponse(17, { type: "result", id: "request-1", result: "continued" });
    await expect(result).resolves.toBe("continued");
  });

  it("converts a synchronous context-handler throw into a scoped error", async () => {
    const test = fixture();
    const result = test.host.request(17, "controller.invoke", {}, {
      handleContextCall: () => {
        throw Object.assign(new Error("No target tab."), { code: "TAB_REQUIRED" });
      },
    });
    expect(() =>
      test.host.acceptContextCall(17, {
        type: "context-call",
        parentId: "request-1",
        id: "context-1",
        method: "context.tab.invoke",
        input: {},
      }),
    ).not.toThrow();
    await vi.waitFor(() => {
      expect(test.sent).toContainEqual(
        expect.objectContaining({
          type: "context-error",
          id: "context-1",
          code: "TAB_REQUIRED",
        }),
      );
    });
    test.host.acceptResponse(17, { type: "result", id: "request-1", result: null });
    await expect(result).resolves.toBeNull();
  });

  it("rejects reuse of a context-call ID within one parent request", async () => {
    const test = fixture();
    const result = test.host.request(17, "controller.invoke", {}, {
      handleContextCall: async () => "first",
    });
    const call = {
      type: "context-call",
      parentId: "request-1",
      id: "context-1",
      method: "context.tabs.open",
      input: {},
    };
    test.host.acceptContextCall(17, call);
    await vi.waitFor(() => {
      expect(test.sent).toContainEqual(
        expect.objectContaining({ type: "context-result", id: "context-1" }),
      );
    });
    test.host.acceptContextCall(17, call);
    expect(test.sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "context-error",
        id: "context-1",
        code: "CONTEXT_CALL_LIMIT",
      }),
    );
    test.host.acceptResponse(17, { type: "result", id: "request-1", result: null });
    await expect(result).resolves.toBeNull();
  });
});

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
});

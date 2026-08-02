import { describe, expect, it, vi } from "vitest";

import { AppPreloadRuntime, type AppPreloadRendererMessage } from "./appPreloadRuntime";

function fixture() {
  const sent: AppPreloadRendererMessage[] = [];
  let hostListener: ((message: unknown) => void) | null = null;
  const ready = vi.fn();
  const runtime = new AppPreloadRuntime({
    send: (message) => sent.push(message),
    onHostMessage: (listener) => {
      hostListener = listener;
      return () => {
        hostListener = null;
      };
    },
    ready,
  });
  runtime.start();
  return {
    runtime,
    sent,
    ready,
    host: (message: unknown) => hostListener?.(message),
  };
}

function controllerRequest(input: unknown = { title: "Fix redirect" }) {
  return {
    type: "request",
    id: "request-1",
    method: "controller.invoke",
    input: {
      operation: "issues.create",
      handler: "issues.create",
      input,
      invocation: {
        id: "inv-1",
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        tabId: "target-tab",
      },
    },
  };
}

describe("AppPreloadRuntime", () => {
  it("announces readiness once and enforces unique handler registration", () => {
    const test = fixture();
    test.runtime.start();
    expect(test.ready).not.toHaveBeenCalled();
    test.runtime.markReady();
    test.runtime.markReady();
    expect(test.ready).toHaveBeenCalledOnce();

    const handler = vi.fn();
    const unregister = test.runtime.api.operations.handle("issues.create", handler);
    expect(() => test.runtime.api.operations.handle("issues.create", vi.fn())).toThrow(
      "already registered",
    );
    unregister();
    expect(() => test.runtime.api.operations.handle("issues.create", vi.fn())).not.toThrow();
  });

  it("invokes a controller handler with separate input and host-owned context", async () => {
    const test = fixture();
    const handler = vi.fn(async (input, context) => ({
      input,
      invocationId: context.invocation.id,
      tabId: context.tab?.id,
    }));
    test.runtime.api.operations.handle("issues.create", handler);
    test.host(controllerRequest());

    await vi.waitFor(() => {
      expect(test.sent).toContainEqual({
        type: "result",
        id: "request-1",
        result: {
          input: { title: "Fix redirect" },
          invocationId: "inv-1",
          tabId: "target-tab",
        },
      });
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("constructs an operation-scoped opened tab handle over context calls", async () => {
    const test = fixture();
    test.runtime.api.operations.handle("issues.create", async (_input, context) => {
      const opened = await context.tabs.open({ route: "/issues/new" });
      return opened.invoke({ operation: "draft.set-title", input: { title: "Fix" } });
    });
    test.host(controllerRequest());

    await vi.waitFor(() => {
      expect(test.sent).toContainEqual(
        expect.objectContaining({
          type: "context-call",
          parentId: "request-1",
          id: "context-1",
          method: "context.tabs.open",
        }),
      );
    });
    test.host({
      type: "context-result",
      parentId: "request-1",
      id: "context-1",
      result: { id: "opened-tab" },
    });
    await vi.waitFor(() => {
      expect(test.sent).toContainEqual({
        type: "context-call",
        parentId: "request-1",
        id: "context-2",
        method: "context.tab.invoke",
        input: {
          handleId: "opened-tab",
          operation: "draft.set-title",
          input: { title: "Fix" },
        },
      });
    });
    test.host({
      type: "context-result",
      parentId: "request-1",
      id: "context-2",
      result: { updated: true },
    });
    await vi.waitFor(() => {
      expect(test.sent).toContainEqual({
        type: "result",
        id: "request-1",
        result: { updated: true },
      });
    });
  });

  it("aborts a controller handler and its context calls on host cancellation", async () => {
    const test = fixture();
    let signal: AbortSignal | undefined;
    test.runtime.api.operations.handle("issues.create", async (_input, context) => {
      signal = context.signal;
      return context.tabs.openForResult({ route: "/issues/new" });
    });
    test.host(controllerRequest());
    await vi.waitFor(() => expect(test.sent).toHaveLength(1));
    test.host({ type: "cancel", id: "request-1", reason: "app-disabled" });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(test.sent.some((message) => message.type === "result" || message.type === "error"))
      .toBe(false);
  });

  it("dispatches point-to-point tab operations and navigation", async () => {
    const test = fixture();
    const tabHandler = vi.fn(async (input) => ({ received: input }));
    const navigationHandler = vi.fn(async ({ route }) => ({ route }));
    test.runtime.api.tab.handle("selection.replace-text", tabHandler);
    test.runtime.api.tab.onNavigate(navigationHandler);

    test.host({
      type: "request",
      id: "tab-request",
      method: "tab.invoke",
      input: { operation: "selection.replace-text", input: { text: "Updated" } },
    });
    test.host({
      type: "request",
      id: "navigate-request",
      method: "tab.navigate-for-result",
      input: { route: "/canvas/2", state: { focus: "title" } },
    });

    await vi.waitFor(() => {
      expect(test.sent).toEqual(
        expect.arrayContaining([
          {
            type: "result",
            id: "tab-request",
            result: { received: { text: "Updated" } },
          },
          {
            type: "result",
            id: "navigate-request",
            result: { route: "/canvas/2" },
          },
        ]),
      );
    });
  });

  it("returns stable errors for missing handlers without exposing stacks", async () => {
    const test = fixture();
    test.host(controllerRequest());
    await vi.waitFor(() => {
      expect(test.sent).toContainEqual({
        type: "error",
        id: "request-1",
        code: "HANDLER_NOT_REGISTERED",
        message: "Operation handler issues.create is not registered.",
      });
    });
  });
});

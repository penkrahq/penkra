import { describe, expect, it, vi } from "vitest";

import {
  AppNodeControllerRuntime,
  type AppNodeControllerTransport,
} from "./appNodeControllerRuntime";

function fixture() {
  const sent: unknown[] = [];
  const serviceCalls: Array<{ method: string; input: unknown }> = [];
  let hostListener: ((message: unknown) => void) | null = null;
  const serviceCall: AppNodeControllerTransport["serviceCall"] = async <Result = unknown>(
    method: string,
    input?: unknown,
  ): Promise<Result> => {
    serviceCalls.push({ method, input });
    return (input ?? null) as Result;
  };
  const ready = vi.fn();
  const runtime = new AppNodeControllerRuntime({
    send: (message) => sent.push(message),
    onHostMessage: (listener) => {
      hostListener = listener;
      return () => {
        hostListener = null;
      };
    },
    serviceCall,
    ready,
  });
  runtime.start();
  return {
    runtime,
    sent,
    serviceCalls,
    ready,
    host: (message: unknown) => hostListener?.(message),
  };
}

function controllerRequest() {
  return {
    type: "request",
    id: "request-1",
    method: "controller.invoke",
    input: {
      handler: "issues.create",
      input: { title: "Fix redirect" },
      invocation: {
        id: "inv-1",
        app: "linear",
        operation: "issues.create",
        spaceId: "personal",
        threadId: "thread-1",
        tabId: "target-tab",
      },
      caller: { kind: "agent" },
    },
  };
}

describe("AppNodeControllerRuntime", () => {
  it("registers unique handlers and invokes them with host-owned context", async () => {
    const test = fixture();
    const handler = vi.fn(async (input, context) => ({
      input,
      invocationId: context.invocation.id,
      tabId: context.tab?.id,
    }));
    test.runtime.api.operations.handle("issues.create", handler);
    expect(() => test.runtime.api.operations.handle("issues.create", vi.fn())).toThrow(
      "already registered",
    );
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
  });

  it("constructs operation-scoped tab handles over context calls", async () => {
    const test = fixture();
    test.runtime.api.operations.handle("issues.create", async (_input, context) => {
      const opened = await context.tabs.open({ route: "/issues/new" });
      return opened.invoke({ operation: "draft.set-title", input: { title: "Fix" } });
    });
    test.host(controllerRequest());
    await vi.waitFor(() =>
      expect(test.sent).toContainEqual(
        expect.objectContaining({
          type: "context-call",
          id: "context-1",
          method: "context.tabs.open",
        }),
      ),
    );
    test.host({
      type: "context-result",
      parentId: "request-1",
      id: "context-1",
      result: { id: "opened-tab" },
    });
    await vi.waitFor(() =>
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
      }),
    );
    test.host({
      type: "context-result",
      parentId: "request-1",
      id: "context-2",
      result: { updated: true },
    });
    await vi.waitFor(() =>
      expect(test.sent).toContainEqual({
        type: "result",
        id: "request-1",
        result: { updated: true },
      }),
    );
  });

  it("uses host services only for Penkra concepts and rejects visual-only SDK surfaces", async () => {
    const test = fixture();
    await expect(test.runtime.api.settings.get("theme")).resolves.toBe("theme");
    expect(test.serviceCalls).toContainEqual({ method: "settings.get", input: "theme" });
    await expect(test.runtime.api.files.list()).rejects.toMatchObject({
      code: "INTERACTIVE_TAB_REQUIRED",
    });
  });

  it("aborts a handler and outstanding context call when the host cancels", async () => {
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
    expect(
      test.sent.some((message: any) => message.type === "result" || message.type === "error"),
    ).toBe(false);
  });
});

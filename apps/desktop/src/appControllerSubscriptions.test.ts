// FILE: appControllerSubscriptions.test.ts
// Purpose: Exercises persistent subscriptions through the real host/controller transport.
import { afterEach, expect, it, vi } from "vitest";
import { AppRendererRpcHost } from "./appRendererRpc";
import { AppNodeControllerRuntime } from "./appNodeControllerRuntime";
import { AppControllerSubscriptionStore } from "./appControllerSubscriptionStore";
import type { AppControllerSubscriptionContext } from "@penkra/sdk";

function fixture() {
  const host = new AppRendererRpcHost();
  let receive: ((message: unknown) => void) | null = null;
  const runtime = new AppNodeControllerRuntime({
    send: (message) => {
      host.acceptResponse(1, message);
    },
    onHostMessage: (listener) => {
      receive = listener;
      return () => {
        receive = null;
      };
    },
    serviceCall: async <A>() => null as A,
    ready: () => undefined,
  });
  runtime.start();
  const retire = host.registerTarget({ id: 1, send: (message) => receive?.(message) });
  let context: AppControllerSubscriptionContext | undefined;
  runtime.api.controller.subscription("watch", (_input, value) => {
    context = value;
  });
  const message = vi.fn();
  const end = vi.fn();
  const controller = new AbortController();
  const stop = host.subscribe(
    1,
    {
      handler: "watch",
      input: {},
      context: { folderId: "folder", threadId: "thread", tabId: "tab" },
    },
    { message, end },
    { signal: controller.signal },
  );
  if (!context) throw new Error("Subscription context not delivered.");
  return { host, runtime, context, message, end, stop, retire, controller };
}
afterEach(() => vi.useRealTimers());
it("keeps a quiet stream beyond two minutes and then delivers a change", () => {
  vi.useFakeTimers();
  const test = fixture();
  vi.advanceTimersByTime(120_001);
  expect(test.context.signal.aborted).toBe(false);
  expect(test.end).not.toHaveBeenCalled();
  test.context.send({ path: "changed" });
  expect(test.message).toHaveBeenCalledExactlyOnceWith({ path: "changed" });
  test.stop();
  expect(test.context.signal.aborted).toBe(true);
  expect(test.end).toHaveBeenCalledOnce();
  test.runtime.dispose();
  test.host.stop();
});
it.each(["stop", "end", "exit", "owner"] as const)(
  "aborts on %s exactly once and suppresses late messages",
  (kind) => {
    const test = fixture();
    if (kind === "stop") test.stop();
    if (kind === "end") test.context.end();
    if (kind === "exit") test.retire("host-stopped");
    if (kind === "owner") test.controller.abort();
    expect(test.context.signal.aborted).toBe(true);
    test.context.send("late");
    test.context.end();
    test.stop();
    expect(test.message).not.toHaveBeenCalled();
    expect(test.end).toHaveBeenCalledOnce();
    test.runtime.dispose();
    test.host.stop();
  },
);
it("keeps one-off deadlines while a subscription stays quiet", async () => {
  vi.useFakeTimers();
  const host = new AppRendererRpcHost();
  host.registerTarget({ id: 1, send: () => undefined });
  const end = vi.fn();
  const stop = host.subscribe(1, {}, { message: vi.fn(), end });
  const pending = host.request(1, "tab.invoke", {}, { timeoutMs: 1000 });
  const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
  vi.advanceTimersByTime(1000);
  await rejection;
  expect(end).not.toHaveBeenCalled();
  stop();
  host.stop();
});
it("tab and generation close cancel only resources owned by that generation", () => {
  const store = new AppControllerSubscriptionStore();
  const owner = {
    appId: "app",
    spaceId: "space",
    folderId: "folder",
    threadId: "thread",
    tabId: "tab",
    rendererId: 1,
  };
  const a = store.add("a", owner);
  const sibling = store.add("b", { ...owner, tabId: "sibling", rendererId: 2 });
  expect(store.take("a", { ...owner, rendererId: 2 })).toBeNull();
  store.closeGeneration(owner);
  expect(a.signal.aborted).toBe(true);
  expect(sibling.signal.aborted).toBe(false);
  store.closeTab({ ...owner, tabId: "sibling" });
  expect(sibling.signal.aborted).toBe(true);
  const pending = store.add("pending", owner);
  store.closeScope("app", "space");
  expect(pending.signal.aborted).toBe(true);
});

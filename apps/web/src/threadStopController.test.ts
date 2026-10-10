import { describe, expect, it } from "vitest";
import {
  ThreadId,
  TurnId,
  type CleanCoreInterruptResult,
  type CleanCoreThreadRuntime,
  type CleanCoreThreadChange,
} from "@penkra/contracts";
import { createThreadStopController } from "./threadStopController";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function harness() {
  const receipt = deferred<CleanCoreInterruptResult>();
  const threadId = ThreadId.makeUnsafe("thread-stop");
  const turnId = TurnId.makeUnsafe("native-turn");
  let runtime: CleanCoreThreadRuntime = { state: "running", activeTurnId: turnId };
  let listener: ((change: CleanCoreThreadChange) => void) | null = null;
  let requests = 0;
  let readError: Error | null = null;
  const errors: unknown[] = [];
  const controller = createThreadStopController(
    {
      interruptThread: () => {
        requests += 1;
        return receipt.promise;
      },
      getThreadRuntime: async () => {
        if (readError !== null) throw readError;
        return runtime;
      },
      onThreadChange: (handler) => {
        listener = handler;
        return () => {
          listener = null;
        };
      },
    },
    threadId,
    (error) => errors.push(error),
  );
  controller.connect();
  return {
    controller,
    receipt,
    threadId,
    turnId,
    errors,
    requests: () => requests,
    setReadError: (error: Error | null) => {
      readError = error;
    },
    setRuntime: (value: CleanCoreThreadRuntime) => {
      runtime = value;
    },
    change: (id: ThreadId) => {
      listener?.({ threadId: id });
    },
  };
}

describe("provider-confirmed Stop", () => {
  it("stays stopping after the interrupt acknowledgement until provider end", async () => {
    const h = harness();
    const stopping = h.controller.stop();
    expect(h.controller.getSnapshot()).toBe(true);
    await h.controller.stop();
    expect(h.requests()).toBe(1);
    h.receipt.resolve({
      threadId: h.threadId,
      interruptRequested: true,
      interruptedTurnId: h.turnId,
    });
    await stopping;
    expect(h.controller.getSnapshot()).toBe(true);
    h.change(ThreadId.makeUnsafe("other-thread"));
    expect(h.controller.getSnapshot()).toBe(true);
    const ended = deferred<void>();
    h.controller.subscribe(() => {
      if (!h.controller.getSnapshot()) ended.resolve();
    });
    h.setRuntime({ state: "idle", activeTurnId: null });
    h.change(h.threadId);
    await ended.promise;
    expect(h.controller.getSnapshot()).toBe(false);
    expect(h.errors).toEqual([]);
    h.controller.dispose();
  });
  it("recognizes an end that arrived before the interrupt acknowledgement", async () => {
    const h = harness();
    const stop = h.controller.stop();
    h.setRuntime({ state: "error", activeTurnId: null });
    h.change(h.threadId);
    h.receipt.resolve({
      threadId: h.threadId,
      interruptRequested: true,
      interruptedTurnId: h.turnId,
    });
    await stop;
    expect(h.controller.getSnapshot()).toBe(false);
    h.controller.dispose();
  });
  it("finishes stopping when the next queued provider turn has already started", async () => {
    const h = harness();
    const stop = h.controller.stop();
    h.setRuntime({ state: "running", activeTurnId: TurnId.makeUnsafe("next-native-turn") });
    h.receipt.resolve({
      threadId: h.threadId,
      interruptRequested: true,
      interruptedTurnId: h.turnId,
    });
    await stop;
    expect(h.controller.getSnapshot()).toBe(false);
    h.controller.dispose();
  });
  it("surfaces a rejected interrupt and releases the button", async () => {
    const h = harness();
    const error = new Error("provider interrupt rejected");
    const stop = h.controller.stop();
    h.receipt.reject(error);
    await stop;
    expect(h.controller.getSnapshot()).toBe(false);
    expect(h.errors).toEqual([error]);
    h.controller.dispose();
  });
  it("keeps stopping through a read failure until a later provider confirmation", async () => {
    const h = harness();
    const error = new Error("runtime read failed");
    h.setReadError(error);
    const stop = h.controller.stop();
    h.receipt.resolve({
      threadId: h.threadId,
      interruptRequested: true,
      interruptedTurnId: h.turnId,
    });
    await stop;
    expect(h.controller.getSnapshot()).toBe(true);
    expect(h.errors).toEqual([error]);
    const ended = deferred<void>();
    h.controller.subscribe(() => {
      if (!h.controller.getSnapshot()) ended.resolve();
    });
    h.setReadError(null);
    h.setRuntime({ state: "idle", activeTurnId: null });
    h.change(h.threadId);
    await ended.promise;
    expect(h.controller.getSnapshot()).toBe(false);
    h.controller.dispose();
  });
  it("does not await an end when the server confirms no running turn", async () => {
    const h = harness();
    const stop = h.controller.stop();
    h.receipt.resolve({ threadId: h.threadId, interruptRequested: false, interruptedTurnId: null });
    await stop;
    expect(h.controller.getSnapshot()).toBe(false);
    h.controller.dispose();
  });
});

import type { NativeApi, ThreadId, TurnId } from "@penkra/contracts";

type StopApi = Pick<
  NativeApi["cleanCore"],
  "interruptThread" | "getThreadRuntime" | "onThreadChange"
>;

export function createThreadStopController(
  api: StopApi,
  threadId: ThreadId,
  onError: (error: unknown) => void,
) {
  const listeners = new Set<() => void>();
  let stopping = false;
  let stoppedTurn: TurnId | null = null;
  let disposed = true;
  let unsubscribe: (() => void) | null = null;
  let request = 0;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const finish = () => {
    stopping = false;
    stoppedTurn = null;
    notify();
  };
  const refresh = async () => {
    const generation = request;
    const turnId = stoppedTurn;
    if (disposed || !stopping || turnId === null) return;
    const runtime = await api.getThreadRuntime({ threadId });
    if (disposed || !stopping || generation !== request) return;
    if (runtime.state !== "running" || runtime.activeTurnId !== turnId) finish();
  };
  return {
    connect: () => {
      disposed = false;
      unsubscribe = api.onThreadChange((change) => {
        if (change.threadId === threadId) void refresh().catch(onError);
      });
    },
    getSnapshot: () => stopping,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: async () => {
      if (disposed || stopping) return;
      const generation = ++request;
      stopping = true;
      notify();
      try {
        const result = await api.interruptThread({ threadId });
        if (disposed || generation !== request) return;
        if (!result.interruptRequested) {
          finish();
          return;
        }
        stoppedTurn = result.interruptedTurnId;
        await refresh().catch(onError);
      } catch (error) {
        if (disposed || generation !== request) return;
        finish();
        onError(error);
      }
    },
    dispose: () => {
      disposed = true;
      request += 1;
      unsubscribe?.();
      unsubscribe = null;
      stopping = false;
      stoppedTurn = null;
    },
  };
}

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface RpcEvent {
  id?: number | string;
  method: string;
  params: Record<string, unknown>;
}

export class NativeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** A test driver over the real native wire, independent of Penkra's adapter. */
export function jsonRpcJournal(child: ChildProcessWithoutNullStreams, signal: AbortSignal) {
  let id = 0;
  let failure: unknown;
  let diagnostic = "";
  const events: RpcEvent[] = [];
  const successfulMethods = new Set<string>();
  const pending = new Map<
    number,
    { method: string; resolve: (result: unknown) => void; reject: (error: unknown) => void }
  >();
  const waiters = new Set<{
    predicate: (event: RpcEvent) => boolean;
    resolve: (event: RpcEvent) => void;
    reject: (error: unknown) => void;
  }>();
  const lines = createInterface({ input: child.stdout });
  const fail = (error: unknown) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  const onAbort = () => fail(signal.reason);
  const onExit = (code: number | null, exitSignal: string | null) =>
    fail(new Error(`Native JSON-RPC process exited ${code}/${exitSignal}: ${diagnostic}`));
  const onError = (error: Error) => fail(error);
  const onStderr = (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4000);
  };
  const onLine = (line: string) => {
    try {
      const value = JSON.parse(line) as RpcEvent & {
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (value.method) {
        events.push(value);
        for (const waiter of waiters)
          if (waiter.predicate(value)) {
            waiters.delete(waiter);
            waiter.resolve(value);
          }
      } else if (typeof value.id === "number") {
        const request = pending.get(value.id);
        pending.delete(value.id);
        if (value.error) request?.reject(new NativeRpcError(value.error.code, value.error.message));
        else if (request) {
          successfulMethods.add(request.method);
          request.resolve(value.result);
        }
      }
    } catch (error) {
      fail(error);
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  child.once("exit", onExit);
  child.once("error", onError);
  child.stderr.on("data", onStderr);
  lines.on("line", onLine);
  const write = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  return {
    events,
    successfulMethods,
    async request<T>(method: string, params: unknown): Promise<T> {
      if (failure) throw failure;
      const requestId = ++id;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(requestId, { method, resolve, reject });
      });
      write({ id: requestId, method, params });
      return (await result) as T;
    },
    notify(method: string) {
      write({ method });
    },
    reply(requestId: number | string, result: unknown) {
      write({ id: requestId, result });
    },
    waitFor(predicate: (event: RpcEvent) => boolean) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      if (failure) return Promise.reject(failure);
      return new Promise<RpcEvent>((resolve, reject) => {
        waiters.add({ predicate, resolve, reject });
      });
    },
    close() {
      signal.removeEventListener("abort", onAbort);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stderr.off("data", onStderr);
      lines.off("line", onLine);
      lines.close();
    },
  };
}

// FILE: appControllerSubscriptions.realtime.integration.ts
// Purpose: Reproduces Explorer's former real 120-second host deadline at the native FS boundary.
// Run once with vitest.subscription-realtime.config.ts; separate from the ordinary fast suites.
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect, it, vi } from "vitest";
import { AppRendererRpcHost } from "./appRendererRpc";
import { AppNodeControllerRuntime } from "./appNodeControllerRuntime";

it("delivers a real write after 130 seconds of quiet through the actual host stream", async () => {
  const startedAt = Date.now();
  const root = await FSP.mkdtemp(Path.join(OS.tmpdir(), "penkra-subscription-realtime-"));
  const path = Path.join(root, "watched.txt");
  await FSP.writeFile(path, "before");
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
  host.registerTarget({ id: 1, send: (message) => receive?.(message) });
  let signal: AbortSignal | undefined;
  let closed: (() => void) | undefined;
  const watcherClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  runtime.api.controller.subscription("watch", (_input, context) => {
    signal = context.signal;
    const watcher = FS.watch(path, () => context.send({ changed: true }));
    watcher.once("close", () => closed?.());
    watcher.once("error", () => context.end());
    context.signal.addEventListener("abort", () => watcher.close(), { once: true });
  });
  const end = vi.fn();
  let changed: ((value: unknown) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const delivered = new Promise<unknown>((resolve, reject) => {
    changed = resolve;
    fail = reject;
  });
  const stop = host.subscribe(
    1,
    {
      handler: "watch",
      input: {},
      context: { folderId: "folder", threadId: "thread", tabId: "tab" },
    },
    {
      message: (value) => changed?.(value),
      end: (error) => {
        end(error);
        if (error) fail?.(error);
      },
    },
  );
  // Wall-clock wait explicitly required by the reviewer: the old host timer ran at 120s.
  const write = setTimeout(() => {
    try {
      expect(end).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
    } catch (error) {
      fail?.(error);
      return;
    }
    void FSP.writeFile(path, "after").catch((error) => fail?.(error));
  }, 130_000);
  try {
    expect(await delivered).toEqual({ changed: true });
    const quietMs = Date.now() - startedAt;
    expect(quietMs).toBeGreaterThanOrEqual(130_000);
    console.info(`Real host subscription delivered after ${quietMs} ms of wall-clock quiet.`);
    stop();
    await watcherClosed;
    expect(signal?.aborted).toBe(true);
    expect(end).toHaveBeenCalledOnce();
  } finally {
    clearTimeout(write);
    stop();
    runtime.dispose();
    host.stop();
    await FSP.rm(root, { recursive: true, force: true });
  }
});

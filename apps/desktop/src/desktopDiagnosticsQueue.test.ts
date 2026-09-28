import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_LIMITS } from "@penkra/shared/diagnostics/limits";

import { DesktopDiagnosticsQueue } from "./desktopDiagnosticsQueue";

class FakeWorker extends EventEmitter {
  readonly messages: unknown[] = [];
  readonly terminate = vi.fn(async () => 0);
  unref(): this {
    return this;
  }
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

describe("desktop diagnostics queue", () => {
  it("bounds pending writes and records rejected messages", async () => {
    const worker = new FakeWorker();
    const drop = vi.fn();
    const queue = new DesktopDiagnosticsQueue(() => worker as unknown as Worker, drop);
    for (let i = 0; i < DIAGNOSTIC_LIMITS.desktopWorkerQueueDepth; i++)
      queue.enqueue("checkpoint", { sequence: i });
    queue.enqueue("checkpoint", { sequence: 999 });
    queue.enqueue("checkpoint", { messageContent: "x".repeat(70_000) });
    expect(worker.messages).toHaveLength(DIAGNOSTIC_LIMITS.desktopWorkerQueueDepth);
    expect(drop).toHaveBeenCalledWith("capacity", 1);
    expect(drop).toHaveBeenCalledTimes(2);
    worker.emit("message", { kind: "ack" });
    queue.enqueue("checkpoint", { sequence: 1000 });
    expect(worker.messages).toHaveLength(DIAGNOSTIC_LIMITS.desktopWorkerQueueDepth + 1);
    const draining = queue.drain();
    for (let i = 0; i < DIAGNOSTIC_LIMITS.desktopWorkerQueueDepth; i++)
      worker.emit("message", { kind: "ack" });
    worker.emit("message", { kind: "drained" });
    await draining;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("counts unacknowledged writes after a worker failure", () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const drop = vi.fn();
    const workers = [first, second];
    const queue = new DesktopDiagnosticsQueue(() => workers.shift()! as unknown as Worker, drop);
    queue.enqueue("checkpoint", { sequence: 1 });
    queue.enqueue("checkpoint", { sequence: 2 });
    first.emit("message", { kind: "ack" });
    first.emit("error", new Error("worker stopped"));
    expect(drop).toHaveBeenCalledWith("spool", 1);
    queue.enqueue("checkpoint", { sequence: 3 });
    expect(second.messages).toHaveLength(1);
  });

  it("stops waiting at the shutdown deadline and counts undrained writes", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const drop = vi.fn();
      const queue = new DesktopDiagnosticsQueue(() => worker as unknown as Worker, drop);
      queue.enqueue("checkpoint", { sequence: 1 });
      queue.enqueue("checkpoint", { sequence: 2 });
      const draining = queue.drain();
      worker.emit("message", { kind: "ack" });
      expect(drop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DIAGNOSTIC_LIMITS.desktopWorkerDrainMs);
      await draining;
      expect(drop).toHaveBeenCalledWith("spool", 1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

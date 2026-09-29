import type { Worker } from "node:worker_threads";
import { DIAGNOSTIC_LIMITS } from "@penkra/shared/diagnostics/limits";

type WriteKind = "checkpoint" | "incident" | "sendExpectation";
type DropReason = "capacity" | "spool";

/** Bounds pending IPC work while the worker owns all normal spool writes. */
export class DesktopDiagnosticsQueue {
  private worker: Worker | null = null;
  private pending = 0;
  private closing = false;
  private resolveDrain: (() => void) | null = null;

  constructor(
    private readonly createWorker: () => Worker,
    private readonly recordDrop: (reason: DropReason, count: number) => void,
    private readonly reserve?: (kind: WriteKind, input: unknown) => string,
  ) {}

  enqueue(kind: WriteKind, input: unknown): void {
    if (this.closing) return this.recordDrop("spool", 1);
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify({ kind, input }));
    } catch {
      return this.recordDrop("spool", 1);
    }
    if (
      bytes > DIAGNOSTIC_LIMITS.desktopWorkerMessageBytes ||
      this.pending >= DIAGNOSTIC_LIMITS.desktopWorkerQueueDepth
    )
      return this.recordDrop("capacity", 1);
    let reserved = false;
    let counted = false;
    try {
      const worker = this.ensureWorker();
      const expectationId = this.reserve?.(kind, input);
      reserved = expectationId !== undefined;
      this.pending++;
      counted = true;
      worker.postMessage({ kind, input, expectationId });
    } catch {
      if (counted) this.pending--;
      if (!reserved) this.recordDrop("spool", 1);
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.unref();
    worker.on("message", (message: { kind?: string }) => {
      if (this.worker !== worker) return;
      if (message?.kind === "ack") this.pending = Math.max(0, this.pending - 1);
      if (message?.kind === "drained") {
        if (this.pending > 0 && !this.reserve) this.recordDrop("spool", this.pending);
        this.pending = 0;
        this.resolveDrain?.();
      }
    });
    worker.on("error", () => this.onWorkerLost(worker));
    worker.on("exit", () => this.onWorkerLost(worker));
    return worker;
  }

  private onWorkerLost(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.pending > 0 && !this.reserve) this.recordDrop("spool", this.pending);
    this.pending = 0;
    this.resolveDrain?.();
  }

  async drain(): Promise<void> {
    this.closing = true;
    const worker = this.worker;
    if (!worker) return;
    const deadline = Date.now() + DIAGNOSTIC_LIMITS.desktopWorkerDrainMs;
    const drained = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), DIAGNOSTIC_LIMITS.desktopWorkerDrainMs);
      this.resolveDrain = () => {
        clearTimeout(timer);
        resolve(true);
      };
      try {
        worker.postMessage({ kind: "shutdown" });
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
    this.resolveDrain = null;
    if (!drained && this.worker === worker) this.onWorkerLost(worker);
    const termination = worker
      .terminate()
      .then(() => undefined)
      .catch(() => undefined);
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0)
      await Promise.race([
        termination,
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
    if (this.worker === worker) this.worker = null;
  }
}

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
  private readonly credits: Array<{ next: number; last: number }> = [];
  private availableCredits = 0;
  private refillRequested = false;
  private overflowCount = 0;

  constructor(
    private readonly createWorker: () => Worker,
    private readonly recordDrop: (reason: DropReason, count: number) => void,
    private readonly reserve?: (kind: WriteKind, input: unknown) => string,
    private readonly useCredits = false,
  ) {}

  enqueue(kind: WriteKind, input: unknown): void {
    if (this.closing) return this.drop("spool");
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify({ kind, input }));
    } catch {
      return this.drop("spool");
    }
    if (
      bytes > DIAGNOSTIC_LIMITS.desktopWorkerMessageBytes ||
      this.pending >= DIAGNOSTIC_LIMITS.desktopWorkerQueueDepth
    )
      return this.drop("capacity");
    if (this.useCredits) {
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch {
        return this.drop("spool");
      }
      const range = this.credits[0];
      if (!range) return this.drop("capacity");
      const queueSlot = range.next++;
      if (range.next > range.last) this.credits.shift();
      this.availableCredits--;
      this.pending++;
      try {
        worker.postMessage({ kind, input, queueSlot });
      } catch {
        this.pending--;
        this.drop("spool");
      }
      if (
        this.availableCredits <= DIAGNOSTIC_LIMITS.desktopWorkerCreditBlock / 2 &&
        !this.refillRequested
      ) {
        this.refillRequested = true;
        try {
          worker.postMessage({ kind: "refill" });
        } catch {
          this.onWorkerLost(worker);
        }
      }
      return;
    }
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

  private drop(reason: DropReason): void {
    if (this.useCredits) {
      this.overflowCount++;
      return;
    }
    this.recordDrop(reason, 1);
  }

  private flushOverflow(worker: Worker): void {
    if (!this.useCredits || this.overflowCount === 0) return;
    const count = this.overflowCount;
    try {
      worker.postMessage({ kind: "overflow", count });
      this.overflowCount = 0;
    } catch {
      this.onWorkerLost(worker);
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.unref();
    worker.on("message", (message: { kind?: string; start?: number; count?: number }) => {
      if (this.worker !== worker) return;
      if (this.useCredits && message?.kind === "credits") {
        if (
          !Number.isSafeInteger(message.start) ||
          !Number.isSafeInteger(message.count) ||
          message.start! < 1 ||
          message.count! < 1
        ) {
          this.onWorkerLost(worker);
          return;
        }
        this.credits.push({ next: message.start!, last: message.start! + message.count! - 1 });
        this.availableCredits += message.count!;
        this.refillRequested = false;
        this.flushOverflow(worker);
      }
      if (message?.kind === "ack") this.pending = Math.max(0, this.pending - 1);
      if (message?.kind === "ack") this.flushOverflow(worker);
      if (message?.kind === "drained") {
        if (this.pending > 0 && !this.reserve && !this.useCredits)
          this.recordDrop("spool", this.pending);
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
    this.credits.length = 0;
    this.availableCredits = 0;
    this.refillRequested = false;
    if (this.pending > 0 && !this.reserve && !this.useCredits)
      this.recordDrop("spool", this.pending);
    this.pending = 0;
    this.resolveDrain?.();
  }

  async drain(): Promise<void> {
    this.closing = true;
    if (this.useCredits && this.overflowCount > 0 && !this.worker) {
      try {
        this.ensureWorker();
      } catch {
        // The attempted writes were never accepted by a durable worker block.
      }
    }
    const worker = this.worker;
    if (!worker) return;
    this.flushOverflow(worker);
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

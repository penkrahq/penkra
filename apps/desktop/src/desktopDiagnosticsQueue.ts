import type { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
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
  private overflowInFlight: { id: string; count: number } | null = null;
  private overflowSent = false;
  private resolveOverflow: (() => void) | null = null;
  private readonly startupBacklog: Array<{ kind: WriteKind; input: unknown }> = [];
  private receivedCredits = false;
  private firstCreditTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly createWorker: () => Worker,
    private readonly recordDrop: (reason: DropReason, count: number) => void,
    private readonly reserve?: (kind: WriteKind, input: unknown) => string,
    private readonly useCredits = false,
    private readonly onWorkerExit?: (bootId: string) => void,
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
      this.pending + this.startupBacklog.length >= DIAGNOSTIC_LIMITS.desktopWorkerQueueDepth
    )
      return this.drop("capacity");
    if (this.useCredits) {
      let worker: Worker;
      try {
        worker = this.ensureWorker();
      } catch {
        return this.drop("spool");
      }
      if (!this.receivedCredits) {
        this.startupBacklog.push({ kind, input });
        return;
      }
      this.sendWithCredit(worker, kind, input);
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

  private sendWithCredit(worker: Worker, kind: WriteKind, input: unknown): void {
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
  }

  private drop(reason: DropReason): void {
    if (this.useCredits) {
      this.overflowCount++;
      return;
    }
    this.recordDrop(reason, 1);
  }

  private flushOverflow(worker: Worker): void {
    if (!this.useCredits) return;
    if (!this.overflowInFlight && this.overflowCount > 0) {
      this.overflowInFlight = { id: randomUUID(), count: this.overflowCount };
      this.overflowCount = 0;
    }
    const report = this.overflowInFlight;
    if (!report || this.overflowSent) return;
    try {
      worker.postMessage({ kind: "overflow", ...report });
      this.overflowSent = true;
    } catch {
      this.onWorkerLost(worker);
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.unref();
    let workerBootId: string | null = null;
    worker.on(
      "message",
      (message: {
        kind?: string;
        start?: number;
        count?: number;
        id?: string;
        bootId?: string;
      }) => {
        if (this.worker !== worker) return;
        if (this.useCredits && message?.kind === "credits") {
          if (
            !message.bootId ||
            !/^[a-f0-9]{32}$/u.test(message.bootId) ||
            !Number.isSafeInteger(message.start) ||
            !Number.isSafeInteger(message.count) ||
            message.start! < 1 ||
            message.count! < 1
          ) {
            this.onWorkerLost(worker);
            return;
          }
          workerBootId = message.bootId;
          this.credits.push({ next: message.start!, last: message.start! + message.count! - 1 });
          this.availableCredits += message.count!;
          this.receivedCredits = true;
          if (this.firstCreditTimer) clearTimeout(this.firstCreditTimer);
          this.firstCreditTimer = null;
          this.refillRequested = false;
          while (this.startupBacklog.length > 0) {
            const item = this.startupBacklog.shift()!;
            this.sendWithCredit(worker, item.kind, item.input);
          }
          this.flushOverflow(worker);
        }
        if (message?.kind === "ack") this.pending = Math.max(0, this.pending - 1);
        if (message?.kind === "ack") this.flushOverflow(worker);
        if (message?.kind === "overflow_ack" && message.id === this.overflowInFlight?.id) {
          this.overflowInFlight = null;
          this.overflowSent = false;
          this.flushOverflow(worker);
          if (!this.overflowInFlight && this.overflowCount === 0) this.resolveOverflow?.();
        }
        if (message?.kind === "overflow_retry" && message.id === this.overflowInFlight?.id) {
          this.overflowSent = false;
          const retry = setTimeout(() => {
            if (this.worker === worker) this.flushOverflow(worker);
          }, 100);
          retry.unref();
        }
        if (message?.kind === "drained") {
          if (this.pending > 0 && !this.reserve && !this.useCredits)
            this.recordDrop("spool", this.pending);
          this.pending = 0;
          this.resolveDrain?.();
        }
      },
    );
    worker.on("error", () => this.onWorkerLost(worker));
    worker.on("exit", () => {
      if (workerBootId) this.onWorkerExit?.(workerBootId);
      this.onWorkerLost(worker);
    });
    if (this.useCredits) {
      this.firstCreditTimer = setTimeout(() => {
        if (this.worker !== worker || this.receivedCredits) return;
        const dropped = this.startupBacklog.length + this.overflowCount;
        if (dropped > 0) {
          try {
            this.recordDrop("spool", dropped);
            this.startupBacklog.length = 0;
            this.overflowCount = 0;
          } catch {
            process.stderr.write("[diagnostics] first-credit timeout loss count failed\n");
          }
        }
        this.onWorkerLost(worker);
        void worker.terminate();
      }, DIAGNOSTIC_LIMITS.desktopWorkerFirstCreditMs);
      this.firstCreditTimer.unref();
    }
    return worker;
  }

  private onWorkerLost(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.credits.length = 0;
    this.availableCredits = 0;
    this.refillRequested = false;
    this.receivedCredits = false;
    if (this.firstCreditTimer) clearTimeout(this.firstCreditTimer);
    this.firstCreditTimer = null;
    this.overflowSent = false;
    if (this.pending > 0 && !this.reserve && !this.useCredits)
      this.recordDrop("spool", this.pending);
    this.pending = 0;
    this.resolveOverflow?.();
    this.resolveDrain?.();
  }

  async drain(): Promise<void> {
    this.closing = true;
    if (this.useCredits && !this.receivedCredits) {
      const dropped = this.startupBacklog.length + this.overflowCount;
      if (dropped > 0) this.recordDrop("spool", dropped);
      this.startupBacklog.length = 0;
      this.overflowCount = 0;
    }
    if (this.useCredits && (this.overflowCount > 0 || this.overflowInFlight) && !this.worker) {
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
    if (this.overflowCount > 0 || this.overflowInFlight) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DIAGNOSTIC_LIMITS.desktopWorkerDrainMs);
        this.resolveOverflow = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.resolveOverflow = null;
      if (this.overflowCount > 0 || this.overflowInFlight) {
        // An unacknowledged report must leave the worker credit ledger unclean.
        // Recovery then records unknown loss instead of silently closing it.
        if (this.worker === worker) this.onWorkerLost(worker);
        await Promise.race([
          worker.terminate().catch(() => 0),
          new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
        ]);
        return;
      }
    }
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

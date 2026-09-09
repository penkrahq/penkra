import type {
  MessageId,
  OrchestrationGetPendingStartOutcomeResult,
  ThreadId,
} from "@penkra/contracts";

export interface PendingStartRecoveryRestoration {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly previewUrls: readonly string[];
  readonly pendingTurn?: unknown;
  readonly restore: () => Promise<void>;
}

interface RecoveryEntry<R extends PendingStartRecoveryRestoration> {
  restoration: R;
  frontier: number | null;
  lookupEligible: boolean;
  inFlight: boolean;
  requestedFollowup: boolean;
  latestRequest: PendingStartRecoveryRequest<R> | null;
  settlement: Promise<void> | null;
}

interface PendingStartRecoveryRequest<R extends PendingStartRecoveryRestoration> {
  threadId: ThreadId;
  messageId: MessageId;
  minimumSequence: number;
  lookup: (minimumSequence: number) => Promise<OrchestrationGetPendingStartOutcomeResult>;
  restoreCancelled: (restoration: R, sequence: number) => Promise<void>;
  fail?: (restoration: R, sequence: number) => Promise<void>;
  accept?: (restoration: R, sequence: number) => Promise<void>;
}

export interface PendingStartRecoveryRegistrationOptions {
  /**
   * A locally captured owner is not a reload record. Keep it out of the
   * automatic revalidation sweep until admission/Stop supplies a frontier.
   */
  readonly deferLookup?: boolean;
}

export class PendingStartRecoveryRegistry<R extends PendingStartRecoveryRestoration> {
  readonly #entries = new Map<ThreadId, Map<MessageId, RecoveryEntry<R>>>();

  #get(threadId: ThreadId, messageId: MessageId): RecoveryEntry<R> | undefined {
    return this.#entries.get(threadId)?.get(messageId);
  }

  register(restoration: R, options: PendingStartRecoveryRegistrationOptions = {}): void {
    const threadEntries = this.#entries.get(restoration.threadId) ?? new Map();
    const current = threadEntries.get(restoration.messageId);
    if (current) {
      if (!current.inFlight && !current.settlement && restoration.pendingTurn !== undefined) {
        current.restoration = restoration;
      }
      // A later owner registration is a new validation trigger, but it must not
      // replace the original recoverable payload while that payload is unresolved.
      if (current.inFlight) current.requestedFollowup = true;
    } else {
      threadEntries.set(restoration.messageId, {
        restoration,
        frontier: null,
        lookupEligible: !options.deferLookup,
        inFlight: false,
        requestedFollowup: false,
        latestRequest: null,
        settlement: null,
      });
      this.#entries.set(restoration.threadId, threadEntries);
    }
  }

  get(threadId: ThreadId, messageId: MessageId): R | undefined {
    return this.#get(threadId, messageId)?.restoration;
  }

  setFrontier(threadId: ThreadId, messageId: MessageId, sequence: number): void {
    const entry = this.#get(threadId, messageId);
    if (!entry) return;
    entry.frontier = Math.max(entry.frontier ?? 0, sequence);
    entry.lookupEligible = true;
  }

  activateForUncertainty(threadId: ThreadId, messageId: MessageId): void {
    const entry = this.#get(threadId, messageId);
    if (!entry) return;
    entry.lookupEligible = true;
  }

  entriesForThread(threadId: ThreadId): ReadonlyArray<{ restoration: R; frontier: number }> {
    return Array.from(this.#entries.get(threadId)?.values() ?? [])
      .filter((entry) => entry.lookupEligible)
      .map((entry) => ({ restoration: entry.restoration, frontier: entry.frontier ?? 0 }));
  }

  restorations(): ReadonlyArray<R> {
    return Array.from(this.#entries.values()).flatMap((entries) =>
      Array.from(entries.values(), (entry) => entry.restoration),
    );
  }

  release(threadId: ThreadId, messageId: MessageId): R | undefined {
    const threadEntries = this.#entries.get(threadId);
    const entry = threadEntries?.get(messageId);
    if (!entry) return undefined;
    threadEntries!.delete(messageId);
    if (threadEntries!.size === 0) this.#entries.delete(threadId);
    return entry.restoration;
  }

  releaseThread(threadId: ThreadId): void {
    this.#entries.delete(threadId);
  }

  async settleCancelled(
    threadId: ThreadId,
    messageId: MessageId,
    sequence: number,
    restoreCancelled: (restoration: R, sequence: number) => Promise<void>,
  ): Promise<void> {
    const entry = this.#get(threadId, messageId);
    if (!entry) return;
    await this.settleExact(threadId, messageId, entry.restoration, restoreCancelled, sequence);
  }

  async settleExact(
    threadId: ThreadId,
    messageId: MessageId,
    restoration: R,
    settle: (restoration: R, sequence: number) => Promise<void>,
    sequence: number,
  ): Promise<void> {
    const threadEntries = this.#entries.get(threadId) ?? new Map<MessageId, RecoveryEntry<R>>();
    let entry = threadEntries.get(messageId);
    if (!entry) {
      entry = {
        restoration,
        frontier: null,
        lookupEligible: true,
        inFlight: false,
        requestedFollowup: false,
        latestRequest: null,
        settlement: null,
      };
      threadEntries.set(messageId, entry);
      this.#entries.set(threadId, threadEntries);
    }
    if (entry.settlement) {
      await entry.settlement;
      return;
    }
    let resolveSettlement!: () => void;
    let rejectSettlement!: (cause: unknown) => void;
    const settlement = new Promise<void>((resolve, reject) => {
      resolveSettlement = resolve;
      rejectSettlement = reject;
    });
    entry.settlement = settlement;
    void (async () => {
      try {
        await settle(entry.restoration, sequence);
        if (this.#get(threadId, messageId) === entry) this.release(threadId, messageId);
        resolveSettlement();
      } catch (cause) {
        rejectSettlement(cause);
      }
    })();
    try {
      await settlement;
    } finally {
      if (this.#get(threadId, messageId) === entry && entry.settlement === settlement) {
        entry.settlement = null;
      }
    }
  }

  async settleAccepted(
    threadId: ThreadId,
    messageId: MessageId,
    sequence: number,
    accept: (restoration: R, sequence: number) => Promise<void>,
  ): Promise<void> {
    const entry = this.#get(threadId, messageId);
    if (!entry) return;
    await this.settleExact(threadId, messageId, entry.restoration, accept, sequence);
  }

  async request(input: PendingStartRecoveryRequest<R>): Promise<void> {
    const entry = this.#get(input.threadId, input.messageId);
    if (!entry) return;
    this.setFrontier(input.threadId, input.messageId, input.minimumSequence);
    entry.latestRequest = input;
    if (entry.inFlight) {
      entry.requestedFollowup = true;
      return;
    }
    entry.inFlight = true;
    const requestFrontier = entry.frontier ?? input.minimumSequence;
    let shouldRunFollowup = false;
    try {
      const outcome = await input.lookup(requestFrontier);
      const current = this.#get(input.threadId, input.messageId);
      const exactOutcome =
        outcome.threadId === input.threadId && outcome.messageId === input.messageId;
      if (current !== entry || !exactOutcome) return;
      // A missing thread is not proof that the start failed: a bounded or
      // lagging projection can omit it while the exact outcome is unknown.
      // Retain the owned payload until the authoritative lookup says accepted
      // or cancelled (or the exact message is explicitly failed).
      if (outcome.outcome === "failed") {
        if (input.fail) await input.fail(entry.restoration, outcome.snapshotSequence);
        if (this.#get(input.threadId, input.messageId) === entry) {
          this.release(input.threadId, input.messageId);
        }
        return;
      }
      if (outcome.outcome === "accepted") {
        if (input.accept) await input.accept(entry.restoration, outcome.snapshotSequence);
        if (this.#get(input.threadId, input.messageId) === entry) {
          this.release(input.threadId, input.messageId);
        }
        return;
      }
      if (outcome.outcome === "cancelled") {
        // The callback owns the exact durable settlement wrapper. Wrapping it
        // here would make a callback that delegates back to settleExact await
        // this same promise.
        if (entry.settlement) {
          await entry.settlement;
          return;
        }
        const latestRestore = entry.latestRequest?.restoreCancelled ?? input.restoreCancelled;
        await latestRestore(entry.restoration, outcome.snapshotSequence);
        if (this.#get(input.threadId, input.messageId) === entry) {
          this.release(input.threadId, input.messageId);
        }
        return;
      }
    } catch {
      // Transport rejection is not an authoritative outcome. Retain the exact
      // owner; a reconnect/frontier trigger will retry it.
    } finally {
      const current = this.#get(input.threadId, input.messageId);
      if (current === entry) {
        entry.inFlight = false;
        shouldRunFollowup = entry.requestedFollowup;
        entry.requestedFollowup = false;
      }
    }
    if (shouldRunFollowup) {
      const current = this.#get(input.threadId, input.messageId);
      const latestRequest = current?.latestRequest;
      if (current === entry && latestRequest) {
        void this.request({
          ...latestRequest,
          minimumSequence: entry.frontier ?? latestRequest.minimumSequence,
        });
      }
    }
  }
}

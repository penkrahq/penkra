import type { MessageId, ThreadId } from "@penkra/contracts";
import type { QueuedComposerTurn } from "../composerDraftStore";

export type QueuedComposerActionKind = "steer" | "delete" | "edit";

export interface QueuedComposerActionClaim {
  readonly action: QueuedComposerActionKind;
  readonly release: () => void;
}

export type QueuedComposerActionSettlementSequences = ReadonlyMap<MessageId, number>;

interface AcceptedQueuedComposerAction {
  readonly receiptSequence: number;
  readonly action: QueuedComposerActionKind;
  readonly queuedTurn: QueuedComposerTurn | null;
}

export interface QueuedComposerActionDiagnosticSample {
  readonly sequence: number;
  readonly recordedAt: string;
  readonly event: "claim" | "claim-conflict" | "release" | "accepted" | "settled";
  readonly threadId: ThreadId;
  readonly queuedTurnId: string | null;
  readonly messageId: MessageId | null;
  readonly action: QueuedComposerActionKind;
  readonly receiptSequence: number | null;
}

export class QueuedComposerActionOwnership {
  readonly #ownersByThread = new Map<
    ThreadId,
    Map<
      string,
      {
        readonly token: symbol;
        readonly action: QueuedComposerActionKind;
        readonly queuedTurn: QueuedComposerTurn | null;
      }
    >
  >();
  readonly #acceptedMessageSequencesByThread = new Map<
    ThreadId,
    Map<MessageId, AcceptedQueuedComposerAction>
  >();
  readonly #listeners = new Set<() => void>();
  readonly #diagnosticSamples: QueuedComposerActionDiagnosticSample[] = [];
  #revision = 0;
  #diagnosticSequence = 1;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getRevision = (): number => this.#revision;

  #publish(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }

  #recordDiagnostic(
    sample: Omit<QueuedComposerActionDiagnosticSample, "sequence" | "recordedAt">,
  ): void {
    this.#diagnosticSamples.push({
      ...sample,
      sequence: this.#diagnosticSequence++,
      recordedAt: new Date().toISOString(),
    });
    if (this.#diagnosticSamples.length > 500) {
      this.#diagnosticSamples.splice(0, this.#diagnosticSamples.length - 500);
    }
  }

  diagnosticSamples(threadId?: ThreadId): readonly QueuedComposerActionDiagnosticSample[] {
    return this.#diagnosticSamples
      .filter((sample) => threadId === undefined || sample.threadId === threadId)
      .map((sample) => Object.assign({}, sample));
  }

  resetForTests(): void {
    this.#ownersByThread.clear();
    this.#acceptedMessageSequencesByThread.clear();
    this.#diagnosticSamples.length = 0;
    this.#diagnosticSequence = 1;
    this.#publish();
  }

  claim(
    threadId: ThreadId,
    queuedTurnId: string,
    action: QueuedComposerActionKind,
    queuedTurn: QueuedComposerTurn | null = null,
  ): QueuedComposerActionClaim | null {
    const threadOwners =
      this.#ownersByThread.get(threadId) ??
      new Map<
        string,
        {
          readonly token: symbol;
          readonly action: QueuedComposerActionKind;
          readonly queuedTurn: QueuedComposerTurn | null;
        }
      >();
    if (threadOwners.has(queuedTurnId)) {
      this.#recordDiagnostic({
        event: "claim-conflict",
        threadId,
        queuedTurnId,
        messageId: null,
        action,
        receiptSequence: null,
      });
      return null;
    }
    const owner = { token: Symbol(action), action, queuedTurn };
    threadOwners.set(queuedTurnId, owner);
    this.#ownersByThread.set(threadId, threadOwners);
    this.#recordDiagnostic({
      event: "claim",
      threadId,
      queuedTurnId,
      messageId: null,
      action,
      receiptSequence: null,
    });
    this.#publish();
    return {
      action,
      release: () => {
        const currentThreadOwners = this.#ownersByThread.get(threadId);
        if (currentThreadOwners?.get(queuedTurnId)?.token !== owner.token) return;
        currentThreadOwners.delete(queuedTurnId);
        if (currentThreadOwners.size === 0) this.#ownersByThread.delete(threadId);
        this.#recordDiagnostic({
          event: "release",
          threadId,
          queuedTurnId,
          messageId: null,
          action,
          receiptSequence: null,
        });
        this.#publish();
      },
    };
  }

  inFlightIds(threadId: ThreadId): ReadonlySet<string> {
    return new Set(this.#ownersByThread.get(threadId)?.keys() ?? []);
  }

  inFlightActions(threadId: ThreadId): ReadonlyMap<string, QueuedComposerActionKind> {
    return new Map(
      [...(this.#ownersByThread.get(threadId)?.entries() ?? [])].map(
        ([queuedTurnId, owner]) => [queuedTurnId, owner.action] as const,
      ),
    );
  }

  inFlightSteerTurns(threadId: ThreadId): readonly QueuedComposerTurn[] {
    return [...(this.#ownersByThread.get(threadId)?.values() ?? [])].flatMap((owner) =>
      owner.action === "steer" && owner.queuedTurn !== null ? [owner.queuedTurn] : [],
    );
  }

  steerTurns(threadId: ThreadId): readonly QueuedComposerTurn[] {
    const turnsById = new Map<string, QueuedComposerTurn>();
    for (const turn of this.inFlightSteerTurns(threadId)) turnsById.set(turn.id, turn);
    for (const accepted of this.#acceptedMessageSequencesByThread.get(threadId)?.values() ?? []) {
      if (accepted.action === "steer" && accepted.queuedTurn !== null) {
        turnsById.set(accepted.queuedTurn.id, accepted.queuedTurn);
      }
    }
    return [...turnsById.values()];
  }

  acceptedMessageIds(threadId: ThreadId): ReadonlySet<MessageId> {
    return new Set(this.#acceptedMessageSequencesByThread.get(threadId)?.keys() ?? []);
  }

  markAccepted(
    threadId: ThreadId,
    messageId: MessageId,
    receiptSequence: number,
    action: QueuedComposerActionKind = "delete",
    queuedTurn: QueuedComposerTurn | null = null,
  ): void {
    const accepted =
      this.#acceptedMessageSequencesByThread.get(threadId) ??
      new Map<MessageId, AcceptedQueuedComposerAction>();
    if (accepted.has(messageId)) return;
    // The command is only marked after the server accepted it, so the queued
    // message was authoritative even if the accepting view unmounted before
    // observing the next projection. Keep the receipt frontier so a reordered
    // older snapshot cannot settle the accepted action by omission.
    accepted.set(messageId, { receiptSequence, action, queuedTurn });
    this.#acceptedMessageSequencesByThread.set(threadId, accepted);
    this.#recordDiagnostic({
      event: "accepted",
      threadId,
      queuedTurnId: queuedTurn?.id ?? null,
      messageId,
      action,
      receiptSequence,
    });
    this.#publish();
  }

  reconcileAccepted(
    threadId: ThreadId,
    settlementSequences: QueuedComposerActionSettlementSequences,
  ): void {
    const accepted = this.#acceptedMessageSequencesByThread.get(threadId);
    if (!accepted) return;
    let changed = false;
    for (const [messageId, acceptedAction] of accepted) {
      const settlementSequence = settlementSequences.get(messageId);
      if (settlementSequence === undefined || settlementSequence < acceptedAction.receiptSequence) {
        continue;
      }
      accepted.delete(messageId);
      this.#recordDiagnostic({
        event: "settled",
        threadId,
        queuedTurnId: acceptedAction.queuedTurn?.id ?? null,
        messageId,
        action: acceptedAction.action,
        receiptSequence: settlementSequence,
      });
      changed = true;
    }
    if (accepted.size === 0) this.#acceptedMessageSequencesByThread.delete(threadId);
    if (changed) this.#publish();
  }
}

const sharedQueuedComposerActionOwnership = new QueuedComposerActionOwnership();

export const claimQueuedComposerAction = sharedQueuedComposerActionOwnership.claim.bind(
  sharedQueuedComposerActionOwnership,
);
export const subscribeQueuedComposerActions = sharedQueuedComposerActionOwnership.subscribe;
export const getQueuedComposerActionRevision = sharedQueuedComposerActionOwnership.getRevision;
export const getQueuedComposerActionInFlightIds = (threadId: ThreadId): ReadonlySet<string> =>
  sharedQueuedComposerActionOwnership.inFlightIds(threadId);
export const getQueuedComposerActionInFlightActions = (
  threadId: ThreadId,
): ReadonlyMap<string, QueuedComposerActionKind> =>
  sharedQueuedComposerActionOwnership.inFlightActions(threadId);
export const getQueuedComposerActionInFlightSteerTurns = (
  threadId: ThreadId,
): readonly QueuedComposerTurn[] =>
  sharedQueuedComposerActionOwnership.inFlightSteerTurns(threadId);
export const getQueuedComposerActionSteerTurns = (
  threadId: ThreadId,
): readonly QueuedComposerTurn[] => sharedQueuedComposerActionOwnership.steerTurns(threadId);
export const getAcceptedQueuedComposerActionMessageIds = (
  threadId: ThreadId,
): ReadonlySet<MessageId> => sharedQueuedComposerActionOwnership.acceptedMessageIds(threadId);
export const markQueuedComposerActionAccepted = (
  threadId: ThreadId,
  messageId: MessageId,
  receiptSequence: number,
  action?: QueuedComposerActionKind,
  queuedTurn?: QueuedComposerTurn | null,
): void =>
  sharedQueuedComposerActionOwnership.markAccepted(
    threadId,
    messageId,
    receiptSequence,
    action,
    queuedTurn,
  );
export const reconcileAcceptedQueuedComposerActions = (
  threadId: ThreadId,
  settlementSequences: QueuedComposerActionSettlementSequences,
): void => sharedQueuedComposerActionOwnership.reconcileAccepted(threadId, settlementSequences);
export const getQueuedComposerActionDiagnosticSamples = (
  threadId?: ThreadId,
): readonly QueuedComposerActionDiagnosticSample[] =>
  sharedQueuedComposerActionOwnership.diagnosticSamples(threadId);
export const resetQueuedComposerActionOwnershipForTests = (): void =>
  sharedQueuedComposerActionOwnership.resetForTests();

declare global {
  interface Window {
    penkraQueuedComposerActions?: {
      samples: typeof getQueuedComposerActionDiagnosticSamples;
    };
  }
}

if (typeof window !== "undefined") {
  window.penkraQueuedComposerActions = {
    samples: getQueuedComposerActionDiagnosticSamples,
  };
}

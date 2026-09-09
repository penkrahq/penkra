import type { MessageId, ThreadId } from "@penkra/contracts";

export type QueuedComposerActionKind = "steer" | "delete" | "edit";

export interface QueuedComposerActionClaim {
  readonly action: QueuedComposerActionKind;
  readonly release: () => void;
}

export type QueuedComposerActionSettlementSequences = ReadonlyMap<MessageId, number>;

export class QueuedComposerActionOwnership {
  readonly #ownersByThread = new Map<ThreadId, Map<string, symbol>>();
  readonly #acceptedMessageSequencesByThread = new Map<ThreadId, Map<MessageId, number>>();
  readonly #listeners = new Set<() => void>();
  #revision = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getRevision = (): number => this.#revision;

  #publish(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }

  claim(
    threadId: ThreadId,
    queuedTurnId: string,
    action: QueuedComposerActionKind,
  ): QueuedComposerActionClaim | null {
    const threadOwners = this.#ownersByThread.get(threadId) ?? new Map<string, symbol>();
    if (threadOwners.has(queuedTurnId)) return null;
    const owner = Symbol(action);
    threadOwners.set(queuedTurnId, owner);
    this.#ownersByThread.set(threadId, threadOwners);
    this.#publish();
    return {
      action,
      release: () => {
        const currentThreadOwners = this.#ownersByThread.get(threadId);
        if (currentThreadOwners?.get(queuedTurnId) !== owner) return;
        currentThreadOwners.delete(queuedTurnId);
        if (currentThreadOwners.size === 0) this.#ownersByThread.delete(threadId);
        this.#publish();
      },
    };
  }

  inFlightIds(threadId: ThreadId): ReadonlySet<string> {
    return new Set(this.#ownersByThread.get(threadId)?.keys() ?? []);
  }

  acceptedMessageIds(threadId: ThreadId): ReadonlySet<MessageId> {
    return new Set(this.#acceptedMessageSequencesByThread.get(threadId)?.keys() ?? []);
  }

  markAccepted(threadId: ThreadId, messageId: MessageId, receiptSequence: number): void {
    const accepted =
      this.#acceptedMessageSequencesByThread.get(threadId) ?? new Map<MessageId, number>();
    if (accepted.has(messageId)) return;
    // The command is only marked after the server accepted it, so the queued
    // message was authoritative even if the accepting view unmounted before
    // observing the next projection. Keep the receipt frontier so a reordered
    // older snapshot cannot settle the accepted action by omission.
    accepted.set(messageId, receiptSequence);
    this.#acceptedMessageSequencesByThread.set(threadId, accepted);
    this.#publish();
  }

  reconcileAccepted(
    threadId: ThreadId,
    settlementSequences: QueuedComposerActionSettlementSequences,
  ): void {
    const accepted = this.#acceptedMessageSequencesByThread.get(threadId);
    if (!accepted) return;
    let changed = false;
    for (const [messageId, receiptSequence] of accepted) {
      const settlementSequence = settlementSequences.get(messageId);
      if (settlementSequence === undefined || settlementSequence < receiptSequence) continue;
      accepted.delete(messageId);
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
export const getAcceptedQueuedComposerActionMessageIds = (
  threadId: ThreadId,
): ReadonlySet<MessageId> => sharedQueuedComposerActionOwnership.acceptedMessageIds(threadId);
export const markQueuedComposerActionAccepted = (
  threadId: ThreadId,
  messageId: MessageId,
  receiptSequence: number,
): void => sharedQueuedComposerActionOwnership.markAccepted(threadId, messageId, receiptSequence);
export const reconcileAcceptedQueuedComposerActions = (
  threadId: ThreadId,
  settlementSequences: QueuedComposerActionSettlementSequences,
): void => sharedQueuedComposerActionOwnership.reconcileAccepted(threadId, settlementSequences);

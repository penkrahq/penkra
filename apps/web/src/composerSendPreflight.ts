import type { MessageId, ThreadId } from "@penkra/contracts";
import { useSyncExternalStore } from "react";
import type { QueuedComposerTurn } from "./composerDraftStore";
import type { ChatMessage } from "./types";
import {
  recordComposerSendPreflightDiagnostic,
  resetComposerSendPreflightDiagnostics,
} from "./composerSendPreflightDiagnostics";

export interface ComposerSendPreflightOwner {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly capturedSubmission: QueuedComposerTurn;
  cancelled: boolean;
  phase: "preflight" | "dispatching";
  messageId: MessageId | null;
  pendingTurn: (QueuedComposerTurn & { messageId: MessageId }) | null;
  admissionReceiptSequence: number | null;
  optimisticMessage: ChatMessage | null;
  readonly claimedImageIds: ReadonlySet<string>;
  activeRunStopRequested: boolean;
}

const owners = new Map<ThreadId, ComposerSendPreflightOwner[]>();
const listeners = new Set<() => void>();
const EMPTY_ACTIVE_THREAD_IDS: ReadonlySet<ThreadId> = new Set();
let activeThreadIdsSnapshot = EMPTY_ACTIVE_THREAD_IDS;
let appliedSyncSequence = 0;

function publish(): void {
  activeThreadIdsSnapshot = new Set([
    ...[...owners.entries()]
      .filter(([, threadOwners]) => threadOwners.some((owner) => !owner.cancelled))
      .map(([threadId]) => threadId),
  ]);
  for (const listener of listeners) listener();
}

export function claimComposerSendPreflight(
  threadId: ThreadId,
  capturedSubmission: QueuedComposerTurn,
  claimedImageIds: readonly string[] = capturedSubmission.images.map((image) => image.id),
  claimedMessageId: MessageId | null = null,
): ComposerSendPreflightOwner | null {
  const threadOwners = owners.get(threadId) ?? [];
  if (threadOwners.some((owner) => owner.phase === "preflight" && !owner.cancelled)) return null;
  const owner = {
    id: crypto.randomUUID(),
    threadId,
    capturedSubmission,
    cancelled: false,
    phase: "preflight" as const,
    messageId: claimedMessageId,
    pendingTurn: null,
    admissionReceiptSequence: null,
    optimisticMessage: null,
    claimedImageIds: new Set(claimedImageIds),
    activeRunStopRequested: false,
  };
  owners.set(threadId, [...threadOwners, owner]);
  recordComposerSendPreflightDiagnostic({
    event: "claim",
    threadId: String(threadId),
    ownerId: owner.id,
    messageId: owner.messageId === null ? null : String(owner.messageId),
    receiptSequence: null,
    appliedSequence: appliedSyncSequence,
  });
  publish();
  return owner;
}

export function setComposerSendPreflightProjection(
  owner: ComposerSendPreflightOwner,
  optimisticMessage: ChatMessage,
): void {
  if (
    !owners
      .get(owner.threadId)
      ?.some((candidate) => candidate.id === owner.id && !candidate.cancelled)
  )
    return;
  owner.optimisticMessage = optimisticMessage;
  recordComposerSendPreflightDiagnostic({
    event: "projection-published",
    threadId: String(owner.threadId),
    ownerId: owner.id,
    messageId: String(optimisticMessage.id),
    receiptSequence: owner.admissionReceiptSequence,
    appliedSequence: appliedSyncSequence,
  });
  publish();
}

export function getComposerSendPreflightProjection(threadId: ThreadId | null): ChatMessage | null {
  if (threadId === null) return null;
  const threadOwners = owners.get(threadId) ?? [];
  const owner =
    threadOwners.find(
      (candidate) =>
        candidate.phase === "preflight" &&
        !candidate.cancelled &&
        candidate.optimisticMessage !== null,
    ) ??
    threadOwners.find((candidate) => !candidate.cancelled && candidate.optimisticMessage !== null);
  return owner?.optimisticMessage ?? null;
}

export function useComposerSendPreflightProjection(threadId: ThreadId | null): ChatMessage | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getComposerSendPreflightProjection(threadId),
    () => null,
  );
}

export function getComposerSendPreflight(threadId: ThreadId): ComposerSendPreflightOwner | null {
  const threadOwners = owners.get(threadId) ?? [];
  return (
    threadOwners.find((owner) => owner.phase === "preflight" && !owner.cancelled) ??
    threadOwners.find((owner) => owner.phase === "dispatching" && !owner.cancelled) ??
    threadOwners.at(-1) ??
    null
  );
}

export function getActiveComposerSendPreparation(
  threadId: ThreadId,
): ComposerSendPreflightOwner | null {
  return (
    owners.get(threadId)?.find((owner) => owner.phase === "preflight" && !owner.cancelled) ?? null
  );
}

export function getComposerDispatchedSendOwner(
  threadId: ThreadId,
): ComposerSendPreflightOwner | null {
  return (
    owners.get(threadId)?.find((owner) => owner.phase === "dispatching" && !owner.cancelled) ?? null
  );
}

export function isComposerImageOwnedBySendPreflight(threadId: ThreadId, imageId: string): boolean {
  return owners.get(threadId)?.some((owner) => owner.claimedImageIds.has(imageId)) ?? false;
}

export function releaseComposerSendPreflight(owner: ComposerSendPreflightOwner): void {
  const threadOwners = owners.get(owner.threadId);
  if (!threadOwners?.some((candidate) => candidate.id === owner.id)) return;
  const next = threadOwners.filter((candidate) => candidate.id !== owner.id);
  if (next.length === 0) owners.delete(owner.threadId);
  else owners.set(owner.threadId, next);
  recordComposerSendPreflightDiagnostic({
    event: "released",
    threadId: String(owner.threadId),
    ownerId: owner.id,
    messageId: owner.messageId === null ? null : String(owner.messageId),
    receiptSequence: null,
    appliedSequence: appliedSyncSequence,
  });
  publish();
}

/** An authoritative recovery outcome supersedes an in-flight command receipt. */
export function settleComposerSendPreflightRecovery(
  threadId: ThreadId,
  messageId: MessageId,
  recoverySequence?: number,
): void {
  const threadOwners = owners.get(threadId) ?? [];
  const settledOwners = threadOwners.filter((owner) => owner.messageId === messageId);
  const next = threadOwners.filter((owner) => owner.messageId !== messageId);
  if (settledOwners.length === 0) return;
  if (next.length === 0) owners.delete(threadId);
  else owners.set(threadId, next);
  recordComposerSendPreflightDiagnostic({
    event: "recovery-settled",
    threadId: String(threadId),
    ownerId: settledOwners[0]!.id,
    messageId: String(messageId),
    receiptSequence: recoverySequence ?? null,
    appliedSequence: appliedSyncSequence,
  });
  publish();
}

export function markComposerSendPreflightAdmission(
  owner: ComposerSendPreflightOwner,
  receiptSequence: number,
): void {
  const threadOwners = owners.get(owner.threadId);
  if (!threadOwners?.some((candidate) => candidate.id === owner.id)) return;
  owner.admissionReceiptSequence = receiptSequence;
  if (owner.messageId !== null) {
    recordComposerSendPreflightDiagnostic({
      event: "admission-retained",
      threadId: String(owner.threadId),
      ownerId: owner.id,
      messageId: String(owner.messageId),
      receiptSequence,
      appliedSequence: appliedSyncSequence,
    });
  }
  settleComposerSendPreflightsThroughAppliedSequence(appliedSyncSequence);
  publish();
}

function settleComposerSendPreflightsThroughAppliedSequence(sequence: number): void {
  let changed = false;
  for (const [threadId, threadOwners] of owners) {
    const settledOwners = threadOwners.filter(
      (owner) =>
        owner.admissionReceiptSequence !== null && owner.admissionReceiptSequence <= sequence,
    );
    if (settledOwners.length === 0) continue;
    const settledOwnerIds = new Set(settledOwners.map((owner) => owner.id));
    const next = threadOwners.filter((owner) => !settledOwnerIds.has(owner.id));
    if (next.length === 0) owners.delete(threadId);
    else owners.set(threadId, next);
    for (const owner of settledOwners) {
      recordComposerSendPreflightDiagnostic({
        event: "applied-frontier-settled",
        threadId: String(threadId),
        ownerId: owner.id,
        messageId: owner.messageId === null ? null : String(owner.messageId),
        receiptSequence: owner.admissionReceiptSequence,
        appliedSequence: sequence,
      });
    }
    changed = true;
  }
  if (changed) publish();
}

export function advanceComposerSendPreflightAppliedSequence(sequence: number): void {
  appliedSyncSequence = Math.max(appliedSyncSequence, sequence);
  settleComposerSendPreflightsThroughAppliedSequence(appliedSyncSequence);
}

export function markComposerSendPreflightDispatching(
  owner: ComposerSendPreflightOwner,
  messageId: MessageId,
  pendingTurn: QueuedComposerTurn & { messageId: MessageId },
): boolean {
  if (
    !owners
      .get(owner.threadId)
      ?.some((candidate) => candidate.id === owner.id && !candidate.cancelled)
  )
    return false;
  owner.phase = "dispatching";
  owner.messageId = messageId;
  owner.pendingTurn = pendingTurn;
  recordComposerSendPreflightDiagnostic({
    event: "dispatching",
    threadId: String(owner.threadId),
    ownerId: owner.id,
    messageId: String(messageId),
    receiptSequence: null,
    appliedSequence: appliedSyncSequence,
  });
  publish();
  return true;
}

export function updateComposerSendPreflightImages(
  owner: ComposerSendPreflightOwner,
  images: QueuedComposerTurn["images"],
): void {
  if (owner.phase !== "preflight") return;
  owner.capturedSubmission.images = [...images];
}

export function markComposerSendPreflightActiveRunStopRequested(
  owner: ComposerSendPreflightOwner,
): void {
  owner.activeRunStopRequested = true;
}

export function updateComposerSendPreflightResolvedAdmission(
  owner: ComposerSendPreflightOwner,
  connectionId: QueuedComposerTurn["connectionId"],
  providerOptionsForDispatch: QueuedComposerTurn["providerOptionsForDispatch"],
): void {
  owner.capturedSubmission.connectionId = connectionId;
  if (providerOptionsForDispatch === undefined) {
    delete owner.capturedSubmission.providerOptionsForDispatch;
  } else {
    owner.capturedSubmission.providerOptionsForDispatch = providerOptionsForDispatch;
  }
}

export function cancelComposerSendPreflight(threadId: ThreadId): ComposerSendPreflightOwner | null {
  const owner = getComposerSendPreflight(threadId);
  if (!owner) return null;
  owner.cancelled = true;
  publish();
  return owner;
}

export function useHasComposerSendPreflight(threadId: ThreadId | null): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => threadId !== null && (owners.get(threadId)?.some((owner) => !owner.cancelled) ?? false),
    () => false,
  );
}

export function useComposerSendPreflightThreadIds(): ReadonlySet<ThreadId> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activeThreadIdsSnapshot,
    () => EMPTY_ACTIVE_THREAD_IDS,
  );
}

export function hasComposerSendActivity(threadId: ThreadId): boolean {
  return activeThreadIdsSnapshot.has(threadId);
}

export function resetComposerSendPreflightsForTests(): void {
  owners.clear();
  appliedSyncSequence = 0;
  resetComposerSendPreflightDiagnostics();
  publish();
}

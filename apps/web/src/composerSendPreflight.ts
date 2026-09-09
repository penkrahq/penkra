import type { MessageId, ThreadId } from "@penkra/contracts";
import { useSyncExternalStore } from "react";
import type { QueuedComposerTurn } from "./composerDraftStore";

export interface ComposerSendPreflightOwner {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly capturedSubmission: QueuedComposerTurn;
  cancelled: boolean;
  phase: "preflight" | "dispatching";
  messageId: MessageId | null;
  pendingTurn: (QueuedComposerTurn & { messageId: MessageId }) | null;
  readonly claimedImageIds: ReadonlySet<string>;
  activeRunStopRequested: boolean;
}

const owners = new Map<ThreadId, ComposerSendPreflightOwner[]>();
const admittedMessageIdsByThread = new Map<ThreadId, Set<MessageId>>();
const listeners = new Set<() => void>();
const EMPTY_ACTIVE_THREAD_IDS: ReadonlySet<ThreadId> = new Set();
let activeThreadIdsSnapshot = EMPTY_ACTIVE_THREAD_IDS;

function publish(): void {
  activeThreadIdsSnapshot = new Set([
    ...[...owners.entries()]
      .filter(([, threadOwners]) => threadOwners.some((owner) => !owner.cancelled))
      .map(([threadId]) => threadId),
    ...admittedMessageIdsByThread.keys(),
  ]);
  for (const listener of listeners) listener();
}

export function claimComposerSendPreflight(
  threadId: ThreadId,
  capturedSubmission: QueuedComposerTurn,
  claimedImageIds: readonly string[] = capturedSubmission.images.map((image) => image.id),
): ComposerSendPreflightOwner | null {
  const threadOwners = owners.get(threadId) ?? [];
  if (threadOwners.some((owner) => owner.phase === "preflight" && !owner.cancelled)) return null;
  const owner = {
    id: crypto.randomUUID(),
    threadId,
    capturedSubmission,
    cancelled: false,
    phase: "preflight" as const,
    messageId: null,
    pendingTurn: null,
    claimedImageIds: new Set(claimedImageIds),
    activeRunStopRequested: false,
  };
  owners.set(threadId, [...threadOwners, owner]);
  publish();
  return owner;
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
  if (owner.messageId) {
    const admitted = admittedMessageIdsByThread.get(owner.threadId);
    admitted?.delete(owner.messageId);
    if (admitted?.size === 0) admittedMessageIdsByThread.delete(owner.threadId);
  }
  publish();
}

export function releaseComposerSendPreflightAfterAdmission(
  owner: ComposerSendPreflightOwner,
): void {
  const threadOwners = owners.get(owner.threadId);
  if (!threadOwners?.some((candidate) => candidate.id === owner.id)) return;
  const next = threadOwners.filter((candidate) => candidate.id !== owner.id);
  if (next.length === 0) owners.delete(owner.threadId);
  else owners.set(owner.threadId, next);
  publish();
}

export function releaseComposerSendPreflightForMessage(
  threadId: ThreadId,
  messageId: MessageId,
): void {
  const threadOwners = owners.get(threadId);
  const next = (threadOwners ?? []).filter(
    (owner) => owner.phase !== "dispatching" || owner.messageId !== messageId,
  );
  const admitted = admittedMessageIdsByThread.get(threadId);
  const removedAdmitted = admitted?.delete(messageId) ?? false;
  const removedOwner = next.length !== (threadOwners?.length ?? 0);
  if (!removedOwner && !removedAdmitted) return;
  if (removedOwner) {
    if (next.length === 0) owners.delete(threadId);
    else owners.set(threadId, next);
  }
  if (admitted?.size === 0) admittedMessageIdsByThread.delete(threadId);
  publish();
}

export function markComposerSendPreflightDispatching(
  owner: ComposerSendPreflightOwner,
  messageId: MessageId,
  pendingTurn: QueuedComposerTurn & { messageId: MessageId },
): void {
  if (!owners.get(owner.threadId)?.some((candidate) => candidate.id === owner.id)) return;
  owner.phase = "dispatching";
  owner.messageId = messageId;
  owner.pendingTurn = pendingTurn;
  const admitted = admittedMessageIdsByThread.get(owner.threadId) ?? new Set<MessageId>();
  admitted.add(messageId);
  admittedMessageIdsByThread.set(owner.threadId, admitted);
  publish();
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
  admittedMessageIdsByThread.clear();
  publish();
}

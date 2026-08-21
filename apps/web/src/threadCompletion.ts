// FILE: threadCompletion.ts
// Purpose: Single-source completion-notification identity and seen-state rules.
// Exports: Completion key derivation and unseen-completion detection.

import type { OrchestrationLatestTurn } from "@penkra/contracts";

type CompletionTurn = Pick<OrchestrationLatestTurn, "turnId" | "completedAt">;

export interface ThreadCompletionState {
  readonly latestTurn: CompletionTurn | null;
  readonly lastVisitedAt?: string | null | undefined;
}

export function getThreadCompletionKey(latestTurn: CompletionTurn | null): string | null {
  if (!latestTurn?.completedAt) {
    return null;
  }
  return ["Completed", latestTurn.turnId, latestTurn.completedAt].join(":");
}

export function hasUnseenThreadCompletion(thread: ThreadCompletionState): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

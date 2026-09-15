// FILE: activeWorkPower.ts
// Purpose: Derives whether any known thread is executing work that should keep the display awake.
// Layer: Client policy

import type { ThreadId } from "@penkra/contracts";

import type { AppState } from "../storeState";
import type { SidebarThreadSummary } from "../types";

type ActiveWorkProjection = Pick<AppState, "threadIds" | "sidebarThreadSummaryById">;

export function hasActiveThreadLifecycle(thread: SidebarThreadSummary): boolean {
  const session = thread.session;
  const orchestrationStatus = session?.orchestrationStatus;
  if (orchestrationStatus === "starting" || orchestrationStatus === "running") {
    return true;
  }
  if (thread.latestTurn?.state !== "running") {
    return false;
  }

  // A running turn can arrive before its session projection. Once a newer
  // terminal session is present, however, that same turn is stale.
  const turnUpdatedAt = thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt;
  return session === null || session === undefined || session.updatedAt < turnUpdatedAt;
}

export function activeThreadExecutionIds(state: ActiveWorkProjection): ReadonlyArray<ThreadId> {
  return (state.threadIds ?? []).filter((threadId: ThreadId) => {
    const thread = state.sidebarThreadSummaryById[threadId];
    if (!thread || thread.archivedAt || thread.hasPendingApprovals || thread.hasPendingUserInput) {
      return false;
    }

    return hasActiveThreadLifecycle(thread);
  });
}

export function hasActiveThreadExecution(state: ActiveWorkProjection): boolean {
  return activeThreadExecutionIds(state).length > 0;
}

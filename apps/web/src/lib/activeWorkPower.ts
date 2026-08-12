// FILE: activeWorkPower.ts
// Purpose: Derives whether any known thread is executing work that should keep the display awake.
// Layer: Client policy

import type { ThreadId } from "@penkra/contracts";

import type { AppState } from "../storeState";

type ActiveWorkProjection = Pick<AppState, "threadIds" | "sidebarThreadSummaryById">;

export function hasActiveThreadExecution(state: ActiveWorkProjection): boolean {
  return (state.threadIds ?? []).some((threadId: ThreadId) => {
    const thread = state.sidebarThreadSummaryById[threadId];
    if (!thread || thread.archivedAt || thread.hasPendingApprovals || thread.hasPendingUserInput) {
      return false;
    }

    const orchestrationStatus = thread.session?.orchestrationStatus;
    return (
      orchestrationStatus === "starting" ||
      orchestrationStatus === "running" ||
      thread.latestTurn?.state === "running"
    );
  });
}

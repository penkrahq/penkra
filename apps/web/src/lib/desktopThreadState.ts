import type { DesktopThreadLiveState } from "../desktopThreadApiBroker";
import type { SidebarThreadSummary } from "../types";

// Existing background-Thread view derivation, not native power policy.
function hasActiveThreadLifecycle(thread: SidebarThreadSummary): boolean {
  const session = thread.session;
  const status = session?.orchestrationStatus;
  if (status === "starting" || status === "running") return true;
  if (thread.latestTurn?.state !== "running") return false;
  const turnUpdatedAt = thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt;
  return session === null || session === undefined || session.updatedAt < turnUpdatedAt;
}

export function deriveUnmountedThreadLiveState(
  threadId: string,
  thread: SidebarThreadSummary | undefined,
  queuedCount: number,
): DesktopThreadLiveState {
  if (!thread) {
    throw Object.assign(new Error("The App's current Thread no longer exists."), {
      code: "THREAD_NOT_FOUND",
    });
  }
  const pendingUserInput = thread.hasPendingUserInput;
  const orchestrationStatus = thread.session?.orchestrationStatus;
  const sessionRunning = orchestrationStatus === "starting" || orchestrationStatus === "running";
  const running = hasActiveThreadLifecycle(thread);
  const activeTurnId =
    sessionRunning && thread.session?.activeTurnId
      ? thread.session.activeTurnId
      : running && thread.latestTurn?.state === "running"
        ? thread.latestTurn.turnId
        : null;
  const failed =
    !running && (orchestrationStatus === "error" || thread.latestTurn?.state === "error");
  return {
    threadId,
    phase: pendingUserInput ? "waiting" : failed ? "failed" : running ? "running" : "idle",
    activeTurnId,
    queuedCount,
    pendingUserInput,
    sendBusy: running,
  };
}

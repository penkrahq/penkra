import {
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ProviderKind,
  type TurnId,
} from "@penkra/contracts";
import { PROVIDER_DESCRIPTORS } from "@penkra/shared/providerMetadata";

import { orderedActivities } from "./workLog";

import type { ChatMessage, SessionPhase, Thread, ThreadSession } from "./types";

export {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "./pendingInteractionDerivation";
export {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  isFileChangeWorkLogEntry,
  isProviderFileEditWorkLogEntry,
  isThreadSelectionWorkEntry,
  isRoutedSubagentWorkEntry,
  omitRoutedSubagentWorkEntries,
  orderedActivities,
  type TimelineEntry,
  type WorkLogEntry,
  type WorkLogLiveActivity,
  type WorkLogLiveActivityState,
  type WorkLogSubagent,
  type WorkLogSubagentAction,
  type WorkLogPenkraCreatedThread,
  type WorkLogPenkraThreadCreation,
} from "./workLog";

export type ProviderPickerKind = ProviderKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = PROVIDER_DESCRIPTORS.map((descriptor) => ({
  value: descriptor.kind,
  label: descriptor.displayName,
  available: descriptor.adapterImplemented,
}));

export interface ActiveTaskListState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  tasks: Array<{
    task: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface ActiveBackgroundTasksState {
  activeCount: number;
  taskIds: string[];
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function formatClockDuration(durationMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatClockElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatClockDuration(endedAt - startedAt);
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<
  OrchestrationLatestTurn,
  "turnId" | "providerTurnId" | "state" | "startedAt" | "completedAt"
>;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

type LatestTurnIdentity = Pick<OrchestrationLatestTurn, "turnId" | "providerTurnId">;

export function latestTurnMatchesTurnId(
  latestTurn: LatestTurnIdentity | null,
  turnId: TurnId | null | undefined,
): boolean {
  if (!latestTurn || !turnId) return false;
  return latestTurn.turnId === turnId || latestTurn.providerTurnId === turnId;
}

export function isSessionActiveLatestTurn(
  latestTurn: LatestTurnIdentity | null,
  session: Pick<ThreadSession, "activeTurnId"> | null,
): boolean {
  return latestTurnMatchesTurnId(latestTurn, session?.activeTurnId);
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (latestTurn.state === "interrupted" || latestTurn.state === "error") {
    return true;
  }
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function hasLiveLatestTurn(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) {
    return false;
  }
  return !isLatestTurnSettled(latestTurn, session);
}

/**
 * Pending approval / user-input requests are only actionable while the session
 * that raised them can still receive the answer. Once the session is closed or
 * errored the request is dead — status surfaces (sidebar pill, kanban column)
 * must not present the thread as awaiting action forever after a provider
 * crash. A thread with no session yet keeps the request actionable: the flag
 * can arrive ahead of the session snapshot.
 */
export function canSessionAnswerPendingRequests(
  session: Pick<ThreadSession, "status"> | null | undefined,
): boolean {
  if (!session) {
    return true;
  }
  return session.status !== "closed" && session.status !== "error";
}

/**
 * Minimal view a session needs to expose to answer "is a turn live?": its status
 * label and its in-flight turn id. Kept structural (not `Pick<ThreadSession>`) so
 * the predicate also accepts the orchestration read-model session, whose status is
 * a wider union and whose `activeTurnId` is `TurnId | null` rather than
 * `TurnId | undefined`. Both shapes satisfy this.
 */
type RunningTurnSessionView = {
  status: string;
  activeTurnId?: TurnId | null | undefined;
};

/**
 * A session is actively running a turn: it reports the `running` status and still
 * has an in-flight `activeTurnId`. This is the single rule for "there is live work
 * on this session right now" during read-model reconciliation. Thread lifecycle
 * cleanup is server-owned and intentionally does not use this predicate as a UI
 * gate.
 */
export function isSessionRunningTurn<T extends RunningTurnSessionView>(
  session: T | null | undefined,
): session is T & { activeTurnId: TurnId } {
  return session != null && session.status === "running" && session.activeTurnId != null;
}

/** Thread-level form of {@link isSessionRunningTurn}: true while the thread's session has an in-flight turn. */
export function isThreadRunningTurn(thread: Pick<Thread, "session">): boolean {
  return isSessionRunningTurn(thread.session);
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  if (latestTurnMatchesTurnId(latestTurn, runningTurnId)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  if (runningTurnId !== null) {
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function toActiveTaskListState(activity: OrchestrationThreadActivity): ActiveTaskListState | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const rawTasks = payload?.tasks;
  if (!Array.isArray(rawTasks)) {
    return null;
  }
  const tasks = rawTasks
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.task !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        task: record.task,
        status,
      };
    })
    .filter(
      (
        task,
      ): task is {
        task: string;
        status: "pending" | "inProgress" | "completed";
      } => task !== null,
    );
  if (rawTasks.length > 0 && tasks.length === 0) {
    return null;
  }
  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    tasks,
  };
}

export function deriveActiveTaskListState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActiveTaskListState | null {
  const ordered = orderedActivities(activities);
  const allTaskListActivities = ordered.filter(
    (activity) => activity.kind === "turn.tasks.updated",
  );

  const currentTurnTaskList = latestTurnId
    ? (allTaskListActivities
        .filter((activity) => activity.turnId === latestTurnId)
        .map(toActiveTaskListState)
        .findLast((taskList) => taskList !== null) ?? null)
    : null;
  if (currentTurnTaskList) {
    return currentTurnTaskList.tasks.length > 0 ? currentTurnTaskList : null;
  }

  // Task lists describe work state beyond the lifetime of one provider turn. Keep the
  // latest unfinished list visible after completion, abort, reload, and follow-up turns
  // until the provider completes every task or sends an explicit empty snapshot.
  const latestPriorTaskList =
    allTaskListActivities.map(toActiveTaskListState).findLast((taskList) => taskList !== null) ??
    null;
  if (!latestPriorTaskList) {
    return null;
  }

  if (latestPriorTaskList.tasks.length === 0) {
    return null;
  }

  return latestPriorTaskList.tasks.some((task) => task.status !== "completed")
    ? latestPriorTaskList
    : null;
}

// Counts still-running background work for the active turn so compact UI can surface agent activity.
export function deriveActiveBackgroundTasksState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActiveBackgroundTasksState | null {
  const ordered = orderedActivities(activities);
  const activeTasks = new Map<string, { taskType?: string | undefined }>();

  for (const activity of ordered) {
    if (
      latestTurnId &&
      activity.turnId &&
      activity.turnId !== latestTurnId &&
      activity.kind !== "task.completed" &&
      activity.kind !== "task.updated"
    ) {
      continue;
    }

    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.updated" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const taskId = payload && typeof payload.taskId === "string" ? payload.taskId : null;
    if (!taskId) {
      continue;
    }

    if (activity.kind === "task.completed") {
      activeTasks.delete(taskId);
      continue;
    }

    // Status patches can end a task (killed/completed/failed) without a
    // task.completed notification following on the same turn.
    if (activity.kind === "task.updated") {
      const status = payload && typeof payload.status === "string" ? payload.status : undefined;
      if (
        status === "completed" ||
        status === "failed" ||
        status === "killed" ||
        status === "paused"
      ) {
        activeTasks.delete(taskId);
      }
      continue;
    }

    const previous = activeTasks.get(taskId);
    const taskType = payload && typeof payload.taskType === "string" ? payload.taskType : undefined;
    activeTasks.set(taskId, {
      taskType: taskType ?? previous?.taskType,
    });
  }

  const activeTaskIds = [...activeTasks.entries()]
    .filter(([, task]) => task.taskType !== "plan")
    .map(([taskId]) => taskId);
  return activeTaskIds.length > 0
    ? { activeCount: activeTaskIds.length, taskIds: activeTaskIds }
    : null;
}

// Keeps live transcript controls active only while assistant text is visibly streaming.
// Background tasks have their own work rows and do not extend the conversational turn.
export function hasLiveTurnTailWork(input: {
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "completedAt"> | null;
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "streaming" | "turnId">>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  session?: Pick<ThreadSession, "orchestrationStatus"> | null;
}): boolean {
  const latestTurnId = input.latestTurn?.turnId;
  if (!latestTurnId) {
    return false;
  }

  const hasStreamingAssistantText = input.messages.some(
    (message) =>
      message.role === "assistant" && message.turnId === latestTurnId && message.streaming,
  );
  if (hasStreamingAssistantText) {
    // Once the turn is terminal, a stale `streaming` flag should not keep the
    // stop button/timer alive indefinitely.
    return input.latestTurn?.completedAt == null;
  }

  return false;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}

/**
 * A pending-start identity is transport handoff state, not an independent source
 * of truth that may keep a settled thread working forever. New deliveries carry
 * their own ordered lifecycle; legacy deliveries remain active only while the
 * authoritative session is still starting.
 */
export function hasActivePendingTurnStart(input: {
  pendingMessageId: ChatMessage["id"] | null | undefined;
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "delivery">>;
  session: Pick<ThreadSession, "orchestrationStatus"> | null | undefined;
}): boolean {
  if (input.pendingMessageId == null) {
    return false;
  }
  const delivery = input.messages.find(
    (message) => message.id === input.pendingMessageId,
  )?.delivery;
  if (delivery?.state === "starting" || delivery?.state === "steering") {
    return true;
  }
  return input.session?.orchestrationStatus === "starting";
}

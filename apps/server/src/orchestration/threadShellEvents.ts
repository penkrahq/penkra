import type { OrchestrationEvent } from "@penkra/contracts";

const THREAD_SHELL_SUMMARY_ACTIVITY_KINDS = new Set([
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

const THREAD_PROJECTION_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-start-requested",
]);

const OTHER_THREAD_SHELL_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.conversation-rolled-back",
  "thread.turn-start-cancelled",
  "thread.session-set",
]);

export function shouldApplyThreadsProjection(event: OrchestrationEvent): boolean {
  return THREAD_PROJECTION_EVENT_TYPES.has(event.type);
}

export function shouldRefreshThreadShellSummary(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
      return event.payload.role === "user";
    case "thread.conversation-rolled-back":
    case "thread.turn-start-cancelled":
    case "thread.session-set":
      return true;
    case "thread.activity-appended":
      return THREAD_SHELL_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
    default:
      return false;
  }
}

/**
 * Events handled by the deferred shell-summary projector.
 *
 * Interaction counts are maintained atomically by the pending-interaction
 * projector, which already owns the before/after settlement state. Keeping
 * them out of the deferred projector avoids rescanning activity history.
 */
export function shouldApplyDeferredThreadShellSummary(event: OrchestrationEvent): boolean {
  if (!shouldRefreshThreadShellSummary(event)) {
    return false;
  }
  return event.type !== "thread.activity-appended";
}

/** True only when an event can change the persisted thread shell sent to sidebar clients. */
export function shouldPublishThreadShellForEvent(event: OrchestrationEvent): boolean {
  if (shouldApplyThreadsProjection(event) || OTHER_THREAD_SHELL_EVENT_TYPES.has(event.type)) {
    return true;
  }
  if (event.type === "thread.message-sent") {
    return event.payload.role === "user" || event.payload.streaming === false;
  }
  if (event.type === "thread.activity-appended") {
    return THREAD_SHELL_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
  }
  return false;
}

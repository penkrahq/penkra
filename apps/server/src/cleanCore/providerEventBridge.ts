// FILE: providerEventBridge.ts
// Purpose: Translate the adapters' ProviderRuntimeEvent stream into the
// clean-core consumer events (turn state and provider exit). 0.14.4 design 2.3.
// Layer: Server clean core
// Exports: toCleanCoreProviderEvents

import type { ProviderRuntimeEvent } from "@penkra/contracts";

import type { CleanCoreProviderEvent } from "./providerStreamConsumer.ts";

/**
 * Map one adapter runtime event to zero or more clean-core consumer events.
 * Turn state is driven only by the provider's own turn lifecycle events, and a
 * session exit cuts off the thread. Events the clean core does not need (usage,
 * metadata, item detail) return an empty list and are handled elsewhere.
 */
export function toCleanCoreProviderEvents(
  event: ProviderRuntimeEvent,
): ReadonlyArray<CleanCoreProviderEvent> {
  switch (event.type) {
    case "turn.started": {
      if (event.turnId === undefined) return [];
      return [
        {
          type: "turn.started",
          threadId: event.threadId,
          turnId: event.turnId,
          at: event.createdAt,
        },
      ];
    }
    case "turn.completed": {
      if (event.turnId === undefined) return [];
      const state =
        event.payload.state === "failed"
          ? ("error" as const)
          : event.payload.state === "interrupted" || event.payload.state === "cancelled"
            ? ("interrupted" as const)
            : ("completed" as const);
      return [
        {
          type: "turn.ended",
          threadId: event.threadId,
          turnId: event.turnId,
          state,
          error: event.payload.errorMessage ?? null,
          at: event.createdAt,
        },
      ];
    }
    case "turn.aborted": {
      if (event.turnId === undefined) return [];
      return [
        {
          type: "turn.ended",
          threadId: event.threadId,
          turnId: event.turnId,
          state: "interrupted",
          at: event.createdAt,
        },
      ];
    }
    case "session.exited": {
      return [{ type: "provider.exited", threadIds: [event.threadId], at: event.createdAt }];
    }
    default:
      return [];
  }
}

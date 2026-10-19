// FILE: providerEventBridge.ts
// Purpose: Translate the adapters' ProviderRuntimeEvent stream into the
// clean-core consumer events. The item upsert is the only transcript writer
// (0.14.4 design 2.1/2.3), so messages, tools, questions and notices
// all map here, keyed by the provider source id.
// Layer: Server clean core
// Exports: toCleanCoreProviderEvents

import type { ProviderRuntimeEvent } from "@penkra/contracts";

import { projectProviderRuntimeActivities } from "../orchestration/providerRuntimeActivityProjection.ts";
import type { CleanCoreProviderEvent } from "./providerStreamConsumer.ts";
import { threadItemActivityData } from "./threadItemData.ts";
import type { ThreadItemKind } from "./threadStore.ts";

const NON_TOOL_NOTICE_TYPES = new Set([
  "context_compaction",
  "error",
  "review_entered",
  "review_exited",
]);

function itemKind(itemType: string): ThreadItemKind | null {
  switch (itemType) {
    case "user_message":
      return "user";
    case "assistant_message":
      return "text";
    case "reasoning":
    case "plan":
    case "unknown":
      return null;
    default:
      return NON_TOOL_NOTICE_TYPES.has(itemType) ? "notice" : "tool";
  }
}

function itemStatus(kind: ThreadItemKind, status: string | undefined): string {
  if (kind === "user") return "sent";
  const failed = status === "failed" || status === "declined";
  if (kind === "text") {
    return status === "completed" ? "done" : failed ? "interrupted" : "streaming";
  }
  if (kind === "tool") {
    return status === "completed" ? "done" : failed ? "error" : "running";
  }
  return "done";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function itemSourceId(event: ProviderRuntimeEvent, data: unknown): string {
  const itemId = asRecord(asRecord(data)?.item)?.id;
  return event.itemId ?? (typeof itemId === "string" && itemId.length > 0 ? itemId : event.eventId);
}

/**
 * One bounded copy of the canonical activity record for a tool/notice item.
 * Reuses the same projection the orchestration read model rendered, so the
 * clean-core transcript shows exactly what the old timeline showed. Notices the
 * projection does not cover fall back to a synthesized record.
 */
function activityItemData(
  event: ProviderRuntimeEvent,
  fallback: { readonly kind: string; readonly summary: string; readonly payload: unknown },
): string {
  const activity = projectProviderRuntimeActivities(event)[0];
  return threadItemActivityData(
    activity ?? {
      tone: "info",
      kind: fallback.kind,
      summary: fallback.summary,
      payload: fallback.payload,
    },
  );
}

/**
 * Map one adapter runtime event to zero or more clean-core consumer events.
 * Turn state comes only from the provider's turn lifecycle; a session exit
 * cuts off the thread. Approvals are not mapped (they are removed).
 */
export function toCleanCoreProviderEvents(
  event: ProviderRuntimeEvent,
): ReadonlyArray<CleanCoreProviderEvent> {
  const ownsTurn = event.providerRefs?.providerParentThreadId === undefined;
  if (
    !ownsTurn &&
    (event.type === "turn.started" ||
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "session.exited")
  )
    return [];
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
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const payload = event.payload;
      const kind = itemKind(payload.itemType);
      if (kind === null) return [];
      if (kind === "user") {
        const admittedTurnId = asRecord(payload.data)?.admittedTurnId;
        return event.provider === "claudeAgent" &&
          event.turnId !== undefined &&
          event.itemId !== undefined &&
          typeof admittedTurnId === "string" &&
          admittedTurnId !== event.turnId
          ? [
              {
                type: "user.consumed",
                threadId: event.threadId,
                sourceId: event.itemId,
                admittedTurnId,
                turnId: event.turnId,
                at: event.createdAt,
              },
            ]
          : [];
      }
      return [
        {
          type: "item",
          threadId: event.threadId,
          item: {
            threadId: event.threadId,
            sourceId: itemSourceId(event, payload.data),
            turnId: event.turnId ?? null,
            kind,
            status: itemStatus(kind, payload.status),
            // Claude can complete a streamed text block without repeating its
            // text (ClaudeAdapter emits detail only when fallbackText exists).
            ...(kind === "text"
              ? payload.detail === undefined
                ? {}
                : { text: payload.detail }
              : {
                  text: payload.detail ?? payload.title ?? null,
                }),
            data:
              kind === "tool" || kind === "notice"
                ? activityItemData(event, {
                    kind: payload.itemType,
                    summary: payload.title ?? payload.detail ?? payload.itemType,
                    payload: { detail: payload.detail ?? null },
                  })
                : null,
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
          },
        },
      ];
    }
    case "content.delta": {
      const streamKind = event.payload.streamKind;
      const kind =
        streamKind === "assistant_text"
          ? ("text" as const)
          : streamKind === "command_output" || streamKind === "file_change_output"
            ? ("tool" as const)
            : null;
      if (kind === null || event.payload.delta.length === 0) return [];
      return [
        {
          type: "delta",
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          sourceId: event.itemId ?? event.eventId,
          kind,
          delta: event.payload.delta,
          at: event.createdAt,
        },
      ];
    }
    case "user-input.requested": {
      const questions = event.payload.questions;
      return [
        {
          type: "item",
          threadId: event.threadId,
          item: {
            threadId: event.threadId,
            sourceId: event.requestId ?? event.eventId,
            turnId: event.turnId ?? null,
            kind: "question",
            status: "open",
            text: questions.map((question) => question.question).join("\n") || "Question",
            data: JSON.stringify({ questions, lifecycleGeneration: event.lifecycleGeneration }),
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
          },
        },
      ];
    }
    case "user-input.resolved": {
      return [
        {
          type: "question.answered",
          threadId: event.threadId,
          sourceId: event.requestId ?? event.eventId,
          answerData: JSON.stringify({ answers: event.payload.answers }),
          at: event.createdAt,
        },
      ];
    }
    case "runtime.warning":
      return [];
    case "runtime.error": {
      return [
        {
          type: "item",
          threadId: event.threadId,
          item: {
            threadId: event.threadId,
            sourceId: event.eventId,
            turnId: event.turnId ?? null,
            kind: "notice",
            status: "done",
            text: event.payload.message,
            data: activityItemData(event, {
              kind: event.type,
              summary: event.payload.message,
              payload: { message: event.payload.message },
            }),
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
          },
        },
        ...(event.type === "runtime.error" && event.payload.terminal && ownsTurn
          ? [
              {
                type: "provider.failed",
                threadIds: [event.threadId],
                reason: event.payload.message,
                at: event.createdAt,
              } as const,
            ]
          : []),
      ];
    }
    case "session.exited": {
      return [
        {
          type: "provider.exited",
          threadIds: [event.threadId],
          at: event.createdAt,
          ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
        },
      ];
    }
    default:
      return [];
  }
}

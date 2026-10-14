// Process-local Codex summary assembly; only completed readable summaries reach SQL.
import type { ProviderRuntimeEvent } from "@penkra/contracts";
import { readableReasoningDetail } from "../orchestration/providerRuntimeActivityProjection.ts";

// Restore 0.14.3's exact buffer bounds, not a new context or delivery policy.
const MAX_BUFFERED_REASONING_SUMMARY_CHARS = 8_000;
const MAX_BUFFERED_REASONING_SUMMARY_PARTS = 24;
const BUFFERED_TEXT_TRUNCATION_MARKER = "... [truncated]";

export function makeReasoningSummaryBuffer() {
  const summaries = new Map<
    string,
    {
      threadId: string;
      turnId: string | undefined;
      parts: Map<number, string>;
    }
  >();
  return (event: ProviderRuntimeEvent): ProviderRuntimeEvent | null => {
    if (
      event.type === "content.delta" &&
      (event.payload.streamKind === "reasoning_text" ||
        event.payload.streamKind === "reasoning_summary_text" ||
        event.payload.streamKind === "plan_text")
    ) {
      if (
        event.provider === "codex" &&
        event.itemId &&
        event.payload.streamKind === "reasoning_summary_text"
      ) {
        const index = event.payload.summaryIndex ?? 0;
        if (index < 0 || index >= MAX_BUFFERED_REASONING_SUMMARY_PARTS || !event.payload.delta)
          return null;
        const key = JSON.stringify([
          event.threadId,
          event.lifecycleGeneration,
          event.turnId,
          event.itemId,
        ]);
        const summary = summaries.get(key) ?? {
          threadId: event.threadId,
          turnId: event.turnId,
          parts: new Map<number, string>(),
        };
        const otherChars = Array.from(summary.parts).reduce(
          (sum, [part, text]) => sum + (part === index ? 0 : text.length),
          0,
        );
        const limit = MAX_BUFFERED_REASONING_SUMMARY_CHARS - otherChars;
        if (limit > 0) {
          const text = (summary.parts.get(index) ?? "") + event.payload.delta;
          summary.parts.set(
            index,
            text.length <= limit
              ? text
              : limit <= BUFFERED_TEXT_TRUNCATION_MARKER.length
                ? BUFFERED_TEXT_TRUNCATION_MARKER.slice(0, limit)
                : text.slice(0, limit - BUFFERED_TEXT_TRUNCATION_MARKER.length) +
                  BUFFERED_TEXT_TRUNCATION_MARKER,
          );
          summaries.set(key, summary);
        }
      }
      return null;
    }
    if (
      event.provider === "codex" &&
      event.type === "item.completed" &&
      event.payload.itemType === "reasoning" &&
      event.itemId
    ) {
      const key = JSON.stringify([
        event.threadId,
        event.lifecycleGeneration,
        event.turnId,
        event.itemId,
      ]);
      const summary = summaries.get(key);
      summaries.delete(key);
      const detail =
        readableReasoningDetail(event.payload.detail) ??
        readableReasoningDetail(
          Array.from(summary?.parts ?? [])
            .sort(([left], [right]) => left - right)
            .map(([, text]) => text.trim())
            .filter(Boolean)
            .join("\n\n"),
        );
      return detail ? { ...event, payload: { ...event.payload, detail } } : event;
    }
    if (
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "session.exited" ||
      (event.type === "runtime.error" && event.payload.terminal)
    ) {
      for (const [key, summary] of summaries) {
        if (
          summary.threadId === event.threadId &&
          (event.type === "session.exited" ||
            event.turnId === undefined ||
            summary.turnId === event.turnId)
        )
          summaries.delete(key);
      }
    }
    return event;
  };
}

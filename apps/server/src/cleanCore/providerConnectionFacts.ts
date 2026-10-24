// FILE: providerConnectionFacts.ts
// Purpose: Connection usage and quota facts in the clean-core provider consumer.
// Layer: Server clean core

import { ProviderConnectionId, type ProviderRuntimeEvent } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionRateLimits } from "../providerUsage/ConnectionRateLimits.ts";

function usageRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nonNegativeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function completedTurnTokenUsage(
  event: Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" }>,
): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
} {
  const usage = usageRecord(event.payload.usage);
  if (!usage) return { inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const outputDetails = usageRecord(usage.output_tokens_details ?? usage.outputTokensDetails);
  const baseInput = nonNegativeTokenCount(usage.input_tokens ?? usage.inputTokens);
  const inputTokens =
    event.provider === "claudeAgent"
      ? baseInput +
        nonNegativeTokenCount(usage.cache_creation_input_tokens) +
        nonNegativeTokenCount(usage.cache_read_input_tokens)
      : baseInput;
  return {
    inputTokens,
    outputTokens: nonNegativeTokenCount(usage.output_tokens ?? usage.outputTokens),
    reasoningOutputTokens: nonNegativeTokenCount(
      usage.reasoning_output_tokens ??
        usage.reasoningOutputTokens ??
        outputDetails?.reasoning_tokens ??
        outputDetails?.reasoningTokens,
    ),
  };
}

const resolveEventConnectionId = (event: ProviderRuntimeEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Composer picks never change the owning account; the turn-start switch does.
    return yield* sql<{ readonly connectionId: string }>`
      SELECT connection_id AS "connectionId"
      FROM threads
      WHERE id = ${event.threadId} AND connection_id IS NOT NULL
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]?.connectionId));
  });

export const writeProviderConnectionFacts = (event: ProviderRuntimeEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (event.type !== "account.rate-limits.updated" && event.type !== "turn.completed") {
      return;
    }
    const connectionId = yield* resolveEventConnectionId(event);
    if (connectionId === undefined) {
      yield* Effect.logWarning("provider account fact has no bound connection", {
        threadId: event.threadId,
        eventType: event.type,
        eventId: event.eventId,
      });
      return;
    }
    const utcDay = event.createdAt.slice(0, 10);

    if (event.type === "account.rate-limits.updated") {
      const rateLimits = event.payload.rateLimits;
      const status =
        rateLimits !== null && typeof rateLimits === "object" && "status" in rateLimits
          ? String((rateLimits as { readonly status?: unknown }).status ?? "") || null
          : null;
      const connectionRateLimits = yield* ConnectionRateLimits;
      yield* connectionRateLimits.update({
        connectionId: ProviderConnectionId.make(connectionId),
        provider: event.provider,
        limitsJson: JSON.stringify(rateLimits),
        status,
        sourceEventId: event.eventId,
        updatedAt: event.createdAt,
      });
      return;
    }

    const tokenUsage = completedTurnTokenUsage(event);
    const connectionRateLimits = yield* ConnectionRateLimits;
    yield* connectionRateLimits.refreshUsage(ProviderConnectionId.make(connectionId));
    yield* Effect.gen(function* () {
      const inserted = yield* sql<{ readonly sourceEventId: string }>`
            INSERT INTO connection_usage_turn_events (source_event_id, connection_id, utc_day)
            VALUES (${event.eventId}, ${connectionId}, ${utcDay})
            ON CONFLICT(source_event_id) DO NOTHING
            RETURNING source_event_id AS "sourceEventId"
          `;
      if (inserted.length === 0) return;
      yield* sql`
            INSERT INTO connection_usage_daily (
              utc_day, connection_id, provider, input_tokens, output_tokens,
              reasoning_output_tokens, turns, updated_at
            ) VALUES (
              ${utcDay}, ${connectionId}, ${event.provider}, ${tokenUsage.inputTokens},
              ${tokenUsage.outputTokens}, ${tokenUsage.reasoningOutputTokens}, 1,
              ${event.createdAt}
            )
            ON CONFLICT(utc_day, connection_id) DO UPDATE SET
              input_tokens = connection_usage_daily.input_tokens + excluded.input_tokens,
              output_tokens = connection_usage_daily.output_tokens + excluded.output_tokens,
              reasoning_output_tokens =
                connection_usage_daily.reasoning_output_tokens + excluded.reasoning_output_tokens,
              turns = connection_usage_daily.turns + 1,
              updated_at = excluded.updated_at
          `;
    });
  });

// FILE: ConnectionUsageFacts.ts
// Purpose: SQLite reader for provider-owned account usage facts.

import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ConnectionDailyUsageFactRecord,
  ConnectionRateLimitFactRecord,
  ConnectionUsageFactRepository,
  type ConnectionUsageFactRepositoryShape,
} from "../Services/ConnectionUsageFacts.ts";

const makeConnectionUsageFactRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectRateLimits = SqlSchema.findOneOption({
    Request: Schema.Struct({ connectionId: ConnectionRateLimitFactRecord.fields.connectionId }),
    Result: ConnectionRateLimitFactRecord,
    execute: ({ connectionId }) => sql`
      SELECT
        connection_id AS "connectionId",
        provider,
        limits_json AS "limitsJson",
        status,
        last_source_event_id AS "sourceEventId",
        updated_at AS "updatedAt"
      FROM connection_rate_limits
      WHERE connection_id = ${connectionId}
    `,
  });
  const upsertRateLimits = SqlSchema.void({
    Request: ConnectionRateLimitFactRecord,
    execute: (record) => sql`
      INSERT INTO connection_rate_limits (
        connection_id,
        provider,
        limits_json,
        status,
        last_source_event_id,
        updated_at
      ) VALUES (
        ${record.connectionId},
        ${record.provider},
        ${record.limitsJson},
        ${record.status},
        ${record.sourceEventId},
        ${record.updatedAt}
      )
      ON CONFLICT(connection_id) DO UPDATE SET
        provider = excluded.provider,
        limits_json = excluded.limits_json,
        status = excluded.status,
        last_source_event_id = excluded.last_source_event_id,
        updated_at = excluded.updated_at
    `,
  });
  const listDailyUsage = SqlSchema.findAll({
    Request: Schema.Struct({
      connectionId: ConnectionRateLimitFactRecord.fields.connectionId,
      sinceUtcDay: Schema.String,
    }),
    Result: ConnectionDailyUsageFactRecord,
    execute: ({ connectionId, sinceUtcDay }) => sql`
      SELECT
        utc_day AS "utcDay",
        connection_id AS "connectionId",
        provider,
        input_tokens AS "inputTokens",
        output_tokens AS "outputTokens",
        reasoning_output_tokens AS "reasoningOutputTokens",
        turns,
        updated_at AS "updatedAt"
      FROM connection_usage_daily
      WHERE connection_id = ${connectionId} AND utc_day >= ${sinceUtcDay}
      ORDER BY utc_day ASC
    `,
  });

  return {
    getRateLimits: (connectionId) =>
      selectRateLimits({ connectionId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ConnectionUsageFactRepository.getRateLimits:query",
            "ConnectionUsageFactRepository.getRateLimits:decode",
          ),
        ),
      ),
    putRateLimits: (record) =>
      upsertRateLimits(record).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ConnectionUsageFactRepository.putRateLimits:query",
            "ConnectionUsageFactRepository.putRateLimits:decode",
          ),
        ),
      ),
    listDailyUsage: (input) =>
      listDailyUsage(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ConnectionUsageFactRepository.listDailyUsage:query",
            "ConnectionUsageFactRepository.listDailyUsage:decode",
          ),
        ),
      ),
  } satisfies ConnectionUsageFactRepositoryShape;
});

export const ConnectionUsageFactRepositoryLive = Layer.effect(
  ConnectionUsageFactRepository,
  makeConnectionUsageFactRepository,
);

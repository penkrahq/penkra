import { OrchestrationEvent } from "@penkra/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from "../Errors.ts";
import {
  ProviderIntentOutbox,
  type ProviderIntentOutboxShape,
  type ProviderIntentOutboxJob,
} from "../Services/ProviderIntentOutbox.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

interface RawJobRow {
  readonly eventSequence: number;
  readonly eventId: string;
  readonly threadId: string;
  readonly laneKey: string;
  readonly eventType: string;
  readonly eventJson: string;
  readonly state: ProviderIntentOutboxJob["state"];
  readonly claimGeneration: number;
  readonly claimOwner: string | null;
  readonly claimExpiresAt: string | null;
  readonly attemptCount: number;
}

const decodeJobRows = (rows: ReadonlyArray<RawJobRow>) =>
  Effect.forEach(rows, (row) =>
    Effect.try({
      try: () => JSON.parse(row.eventJson) as unknown,
      catch: toPersistenceDecodeCauseError("ProviderIntentOutbox.eventJson"),
    }).pipe(
      Effect.flatMap(decodeEvent),
      Effect.map((event) => ({
        eventSequence: row.eventSequence,
        eventId: row.eventId,
        threadId: row.threadId,
        laneKey: row.laneKey,
        eventType: row.eventType,
        event,
        state: row.state,
        claimGeneration: row.claimGeneration,
        claimOwner: row.claimOwner,
        claimExpiresAt: row.claimExpiresAt,
        attemptCount: row.attemptCount,
      })),
    ),
  );

export const ProviderIntentOutboxLive = Layer.effect(
  ProviderIntentOutbox,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const jobColumns = sql`
      event_sequence AS "eventSequence", event_id AS "eventId",
      thread_id AS "threadId", lane_key AS "laneKey", event_type AS "eventType",
      event_json AS "eventJson", state,
      claim_generation AS "claimGeneration", claim_owner AS "claimOwner",
      claim_expires_at AS "claimExpiresAt", attempt_count AS "attemptCount"
    `;

    const getLegacyCutover: ProviderIntentOutboxShape["getLegacyCutover"] = () =>
      sql<{ readonly throughSequence: number; readonly drainedAt: string | null }>`
        SELECT legacy_through_sequence AS "throughSequence",
          legacy_drained_at AS "drainedAt"
        FROM provider_intent_outbox_cutover WHERE id = 1
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0]
            ? Effect.succeed(rows[0])
            : Effect.die(new Error("Provider outbox cutover marker is missing")),
        ),
        Effect.mapError(toPersistenceSqlError("ProviderIntentOutbox.getLegacyCutover")),
      );

    const markLegacyDrained: ProviderIntentOutboxShape["markLegacyDrained"] = (at) =>
      sql<{ readonly id: number }>`
        UPDATE provider_intent_outbox_cutover
        SET legacy_drained_at = COALESCE(legacy_drained_at, ${at})
        WHERE id = 1 RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ProviderIntentOutbox.markLegacyDrained")),
      );

    const enqueueInCurrentTransaction: ProviderIntentOutboxShape["enqueueInCurrentTransaction"] = (
      event,
    ) =>
      Effect.gen(function* () {
        // A subagent shares its ancestor's provider session. A native fork
        // has no parent_thread_id and therefore owns its own lane.
        const startThreadId =
          event.type === "thread.created" && event.payload.parentThreadId
            ? event.payload.parentThreadId
            : event.payload.threadId;
        const ancestors = yield* sql<{
          readonly laneKey: string;
          readonly parentThreadId: string | null;
          readonly depth: number;
        }>`
            WITH RECURSIVE ancestry(thread_id, parent_thread_id, depth) AS (
              SELECT thread_id, parent_thread_id, 0
              FROM projection_threads
              WHERE thread_id = ${startThreadId}
              UNION ALL
              SELECT parent.thread_id, parent.parent_thread_id, ancestry.depth + 1
              FROM projection_threads AS parent
              JOIN ancestry ON parent.thread_id = ancestry.parent_thread_id
              WHERE ancestry.depth < 32
            )
            SELECT thread_id AS "laneKey", parent_thread_id AS "parentThreadId", depth
            FROM ancestry ORDER BY depth DESC LIMIT 1
          `;
        const ancestor = ancestors[0];
        if (ancestor && ancestor.depth === 32 && ancestor.parentThreadId !== null) {
          return yield* Effect.die(
            new Error(`Provider lane ancestry exceeds 32 threads for ${event.payload.threadId}`),
          );
        }
        const laneKey = ancestor?.laneKey ?? startThreadId;
        yield* sql`
            INSERT INTO provider_intent_outbox (
              event_sequence, event_id, thread_id, lane_key, event_type,
              event_json, state, created_at, updated_at
            ) VALUES (
              ${event.sequence}, ${event.eventId}, ${event.payload.threadId}, ${laneKey},
              ${event.type}, ${JSON.stringify(event)}, 'pending',
              ${event.occurredAt}, ${event.occurredAt}
            )
          `;
      }).pipe(Effect.mapError(toPersistenceSqlError("ProviderIntentOutbox.enqueue")));

    const readPending: ProviderIntentOutboxShape["readPending"] = (limit) =>
      Effect.gen(function* () {
        const rows = yield* sql<RawJobRow>`
          SELECT ${jobColumns}
          FROM provider_intent_outbox
          WHERE state IN ('pending', 'retry')
          ORDER BY event_sequence LIMIT ${Math.max(1, Math.min(limit, 500))}
        `;
        return yield* decodeJobRows(rows);
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderIntentOutbox.readPending",
            "ProviderIntentOutbox.readPending:event",
          ),
        ),
      );

    const listRunnableLaneHeads: ProviderIntentOutboxShape["listRunnableLaneHeads"] = (limit) =>
      Effect.gen(function* () {
        const rows = yield* sql<RawJobRow>`
          SELECT ${jobColumns}
          FROM provider_intent_outbox AS job
          WHERE job.state IN ('pending', 'retry')
            AND NOT EXISTS (
              SELECT 1 FROM provider_intent_outbox AS older
              WHERE older.lane_key = job.lane_key
                AND older.event_sequence < job.event_sequence
                AND older.state NOT IN ('succeeded', 'abandoned')
            )
          ORDER BY job.event_sequence LIMIT ${Math.max(1, Math.min(limit, 500))}
        `;
        return yield* decodeJobRows(rows);
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderIntentOutbox.listRunnableLaneHeads",
            "ProviderIntentOutbox.listRunnableLaneHeads:event",
          ),
        ),
      );

    const claimLaneHead: ProviderIntentOutboxShape["claimLaneHead"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<RawJobRow>`
          UPDATE provider_intent_outbox
          SET state = 'inflight', claim_owner = ${input.owner},
            claim_generation = claim_generation + 1,
            claimed_at = ${input.now}, claim_expires_at = ${input.expiresAt},
            attempt_count = attempt_count + 1, updated_at = ${input.now}
          WHERE event_sequence = ${input.eventSequence}
            AND lane_key = ${input.laneKey}
            AND state IN ('pending', 'retry')
            AND NOT EXISTS (
              SELECT 1 FROM provider_intent_outbox AS older
              WHERE older.lane_key = ${input.laneKey}
                AND older.event_sequence < ${input.eventSequence}
                AND older.state NOT IN ('succeeded', 'abandoned')
            )
          RETURNING ${jobColumns}
        `;
        const decoded = yield* decodeJobRows(rows);
        return Option.fromNullishOr(decoded[0]);
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderIntentOutbox.claimLaneHead",
            "ProviderIntentOutbox.claimLaneHead:event",
          ),
        ),
      );

    const settleClaim: ProviderIntentOutboxShape["settleClaim"] = (input) =>
      sql<{ readonly eventSequence: number }>`
        UPDATE provider_intent_outbox
        SET state = ${input.state}, claim_owner = NULL,
          claimed_at = NULL, claim_expires_at = NULL,
          last_error = ${input.error ?? null},
          completed_at = ${input.state === "retry" ? null : input.at},
          updated_at = ${input.at}
        WHERE event_sequence = ${input.eventSequence}
          AND state = 'inflight'
          AND claim_owner = ${input.owner}
          AND claim_generation = ${input.generation}
        RETURNING event_sequence AS "eventSequence"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ProviderIntentOutbox.settleClaim")),
      );

    const countUnsettledThrough: ProviderIntentOutboxShape["countUnsettledThrough"] = (
      throughSequence,
    ) =>
      sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM provider_intent_outbox
          WHERE event_sequence <= ${throughSequence}
            AND state NOT IN ('succeeded', 'abandoned')
        `.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(toPersistenceSqlError("ProviderIntentOutbox.countUnsettledThrough")),
      );

    const listExpiredClaims: ProviderIntentOutboxShape["listExpiredClaims"] = (now) =>
      Effect.gen(function* () {
        const rows = yield* sql<RawJobRow>`
          SELECT ${jobColumns} FROM provider_intent_outbox
          WHERE state = 'inflight' AND claim_expires_at <= ${now}
          ORDER BY event_sequence LIMIT 500
        `;
        return yield* decodeJobRows(rows);
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderIntentOutbox.listExpiredClaims",
            "ProviderIntentOutbox.listExpiredClaims:event",
          ),
        ),
      );

    const settleExpiredClaim: ProviderIntentOutboxShape["settleExpiredClaim"] = (input) =>
      sql<{ readonly eventSequence: number }>`
        UPDATE provider_intent_outbox
        SET state = ${input.state}, claim_owner = NULL,
          claimed_at = NULL, claim_expires_at = NULL,
          last_error = ${input.error}, updated_at = ${input.now}
        WHERE event_sequence = ${input.eventSequence}
          AND state = 'inflight'
          AND claim_owner = ${input.owner}
          AND claim_generation = ${input.generation}
          AND claim_expires_at <= ${input.now}
        RETURNING event_sequence AS "eventSequence"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ProviderIntentOutbox.settleExpiredClaim")),
      );

    const abandonAfterFence: ProviderIntentOutboxShape["abandonAfterFence"] = (input) =>
      sql<{ readonly eventSequence: number }>`
        UPDATE provider_intent_outbox
        SET state = 'abandoned', completed_at = ${input.at}, updated_at = ${input.at}
        WHERE event_sequence = ${input.eventSequence}
          AND state IN ('dead', 'uncertain')
        RETURNING event_sequence AS "eventSequence"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ProviderIntentOutbox.abandonAfterFence")),
      );

    return {
      getLegacyCutover,
      markLegacyDrained,
      enqueueInCurrentTransaction,
      readPending,
      listRunnableLaneHeads,
      claimLaneHead,
      settleClaim,
      countUnsettledThrough,
      listExpiredClaims,
      settleExpiredClaim,
      abandonAfterFence,
    };
  }),
);

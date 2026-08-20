import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { redactCreationPlanForPurgedCaller } from "./agentGateway/operationPlan";
import { isProviderIntentEventType } from "./orchestration/providerIntentClassification";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "./persistence/Services/OrchestrationEventDeliveries";
import { THREAD_RETENTION_COMMAND_ID_PREFIX } from "./threadRetention";

export interface ThreadPurgeShape {
  readonly hasPurgeFence: (threadId: string) => Effect.Effect<boolean, unknown>;
  readonly purge: (threadId: string) => Effect.Effect<boolean, unknown>;
  readonly purgeSoftDeletedManualThreads: (input?: {
    readonly beforePurge?: (threadId: string) => Effect.Effect<boolean, unknown>;
  }) => Effect.Effect<number, unknown>;
}

export class ThreadPurge extends ServiceMap.Service<ThreadPurge, ThreadPurgeShape>()(
  "penkra/maintenance/ThreadPurge",
) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const hasPurgeFence: ThreadPurgeShape["hasPurgeFence"] = (threadId) =>
    Effect.gen(function* () {
      const durableRows = yield* sql<{ readonly fenced: number }>`
        SELECT CASE WHEN
          EXISTS (
            SELECT 1
            FROM orchestration_event_deliveries
            WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
              AND thread_id = ${threadId}
              AND state IN ('inflight', 'retry', 'dead', 'uncertain')
          )
          OR EXISTS (
            SELECT 1
            FROM queued_turn_promotions
            WHERE thread_id = ${threadId}
              AND state IN ('queued', 'promoting')
          )
        THEN 1 ELSE 0 END AS fenced
      `;
      if ((durableRows[0]?.fenced ?? 0) === 1) return true;

      const unconsumedRows = yield* sql<{ readonly eventType: string }>`
        SELECT e.event_type AS "eventType"
        FROM orchestration_events e
        WHERE e.sequence > COALESCE(
          (
            SELECT last_acked_sequence
            FROM orchestration_consumer_state
            WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
          ),
          0
        )
          AND e.aggregate_kind = 'thread'
          AND (
            e.stream_id = ${threadId}
            OR json_extract(e.payload_json, '$.threadId') = ${threadId}
          )
      `;
      return unconsumedRows.some((row) => isProviderIntentEventType(row.eventType));
    });

  const purge: ThreadPurgeShape["purge"] = (threadId) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const threads = yield* sql<{ readonly deletedAt: string | null }>`
          SELECT deleted_at AS "deletedAt"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        if (!threads[0]) return false;
        if (yield* hasPurgeFence(threadId)) return false;
        const deletedAt = threads[0].deletedAt ?? new Date().toISOString();

        yield* sql`
          DELETE FROM orchestration_event_deliveries
          WHERE consumer_name = ${PROVIDER_COMMAND_REACTOR_CONSUMER}
            AND thread_id = ${threadId}
            AND state = 'succeeded'
        `;
        yield* sql`
          DELETE FROM queued_turn_promotions
          WHERE thread_id = ${threadId}
            AND state IN ('promoted', 'cancelled')
        `;
        yield* sql`
          DELETE FROM agent_gateway_operations
          WHERE caller_thread_id = ${threadId}
            AND status IN ('reserved', 'completed', 'failed')
        `;
        const liveGatewayOperations = yield* sql<{
          readonly operationId: string;
          readonly planJson: string;
        }>`
          SELECT operation_id AS "operationId", plan_json AS "planJson"
          FROM agent_gateway_operations
          WHERE caller_thread_id = ${threadId}
            AND status IN ('dispatching', 'compensating')
        `;
        yield* Effect.forEach(
          liveGatewayOperations,
          (operation) => {
            const recoveryPlanJson = redactCreationPlanForPurgedCaller({
              planJson: operation.planJson,
              operationId: operation.operationId,
            });
            return sql`
              UPDATE agent_gateway_operations
              SET plan_json = ${recoveryPlanJson},
                  caller_thread_id = 'purged-thread:' || operation_id,
                  caller_turn_id = 'purged-turn:' || operation_id,
                  request_id = operation_id,
                  fingerprint = operation_id,
                  result_json = NULL,
                  error_json = NULL,
                  caller_purged_at = ${deletedAt},
                  updated_at = ${deletedAt}
              WHERE operation_id = ${operation.operationId}
                AND status IN ('dispatching', 'compensating')
            `;
          },
          { concurrency: 1, discard: true },
        );

        yield* sql`
          DELETE FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND (
              stream_id = ${threadId}
              OR json_extract(payload_json, '$.threadId') = ${threadId}
            )
        `;
        yield* sql`DELETE FROM operations WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM notices WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM restart_turn_recoveries WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM provider_runtime_events WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_pending_interactions WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
        return true;
      }),
    );

  const purgeSoftDeletedManualThreads: ThreadPurgeShape["purgeSoftDeletedManualThreads"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const candidates = yield* sql<{ readonly threadId: string }>`
        SELECT t.thread_id AS "threadId"
        FROM projection_threads t
        WHERE t.deleted_at IS NOT NULL
          AND (
            SELECT td.command_id
            FROM orchestration_events td
            WHERE td.event_type = 'thread.deleted'
              AND td.stream_id = t.thread_id
            ORDER BY td.sequence DESC
            LIMIT 1
          ) NOT LIKE ${`${THREAD_RETENTION_COMMAND_ID_PREFIX}%`}
      `;
      let purgedCount = 0;
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            if (input?.beforePurge && !(yield* input.beforePurge(candidate.threadId))) return;
            if (yield* purge(candidate.threadId)) purgedCount += 1;
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to purge soft-deleted thread", {
                threadId: candidate.threadId,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
      return purgedCount;
    });

  return { hasPurgeFence, purge, purgeSoftDeletedManualThreads } satisfies ThreadPurgeShape;
});

export const ThreadPurgeLive = Layer.effect(ThreadPurge, make);

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "../Services/ProviderRuntimeEvents.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("090_ThreadScopedProviderRuntimeProjection", (it) => {
  it.effect("seeds thread cursors from the accepted legacy global cursor", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });

      yield* sql`
        INSERT INTO provider_runtime_events (
          event_id, thread_id, turn_id, lifecycle_generation,
          event_type, event_json, persisted_at
        ) VALUES
          ('event-a-accepted', 'thread-a', 'turn-a', NULL, 'content.delta', '{}',
            '2026-07-31T10:00:00.000Z'),
          ('event-b-accepted', 'thread-b', 'turn-b', NULL, 'content.delta', '{}',
            '2026-07-31T10:00:01.000Z'),
          ('event-a-pending', 'thread-a', 'turn-a', NULL, 'turn.completed', '{}',
            '2026-07-31T10:00:02.000Z')
      `;
      yield* sql`
        UPDATE provider_runtime_event_consumers
        SET last_acked_sequence = 2, updated_at = '2026-07-31T10:00:03.000Z'
        WHERE consumer_name = ${PROVIDER_RUNTIME_INGESTION_CONSUMER}
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 90 });
      assert.deepStrictEqual(executed, [[90, "ThreadScopedProviderRuntimeProjection"]]);

      const cursors = yield* sql<{
        readonly threadId: string;
        readonly lastAckedSequence: number;
      }>`
        SELECT
          thread_id AS "threadId",
          last_acked_sequence AS "lastAckedSequence"
        FROM provider_runtime_thread_cursors
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(cursors, [
        { threadId: "thread-a", lastAckedSequence: 1 },
        { threadId: "thread-b", lastAckedSequence: 2 },
      ]);

      const pending = yield* sql<{ readonly eventId: string }>`
        SELECT event.event_id AS "eventId"
        FROM provider_runtime_events AS event
        LEFT JOIN provider_runtime_thread_cursors AS cursor
          ON cursor.thread_id = event.thread_id
        WHERE event.sequence > COALESCE(cursor.last_acked_sequence, 0)
        ORDER BY event.sequence
      `;
      assert.deepStrictEqual(pending, [{ eventId: "event-a-pending" }]);
    }),
  );
});

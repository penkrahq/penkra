import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("163_MessageDeliveryFailureEvidence", (it) => {
  it.effect("backfills only the failure event that still owns the current delivery sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 162 });
      const occurredAt = "2026-09-11T15:38:51.000Z";
      const retainedPayload = JSON.stringify({
        threadId: "thread-retained",
        messageId: "message-retained",
        state: "failed",
        failurePhase: "before-provider-dispatch",
        failureDetail: "Operation not permitted (os error 1)",
      });
      const stalePayload = JSON.stringify({
        threadId: "thread-stale",
        messageId: "message-stale",
        state: "failed",
        failurePhase: "before-provider-dispatch",
        failureDetail: "old startup failure",
      });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES
          ('event-retained', 'thread', 'thread-retained', 0, 'thread.message-delivery-set',
           ${occurredAt}, 'system', ${retainedPayload}, '{}'),
          ('event-stale', 'thread', 'thread-stale', 0, 'thread.message-delivery-set',
           ${occurredAt}, 'system', ${stalePayload}, '{}')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, delivery_state, delivery_queued,
          delivery_sequence, is_streaming, created_at, updated_at
        ) VALUES
          ('message-retained', 'thread-retained', 'user', 'retained', 'failed', 0, 1, 0,
           ${occurredAt}, ${occurredAt}),
          ('message-stale', 'thread-stale', 'user', 'stale', 'accepted', 0, 3, 0,
           ${occurredAt}, ${occurredAt})
      `;

      yield* runMigrations();

      const rows = yield* sql<{
        readonly messageId: string;
        readonly phase: string | null;
        readonly detail: string | null;
      }>`
        SELECT message_id AS "messageId", delivery_failure_phase AS phase,
               delivery_failure_detail AS detail
        FROM projection_thread_messages
        ORDER BY message_id
      `;
      assert.deepEqual(rows, [
        {
          messageId: "message-retained",
          phase: "before-provider-dispatch",
          detail: "Operation not permitted (os error 1)",
        },
        { messageId: "message-stale", phase: null, detail: null },
      ]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("137_RemoveCheckpointing", (it) => {
  it.effect("removes checkpoint persistence while preserving canonical turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 136 });

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          'thread-keep', 'turn-keep', 'message-user', 'message-assistant', 'completed',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:01.000Z',
          '2026-08-19T00:00:02.000Z', 1, 'checkpoint-keep', 'ready', '[]'
        )
      `;
      yield* sql`
        INSERT INTO restart_turn_recoveries (
          thread_id, turn_id, message_id, requested_at, updated_at
        ) VALUES (
          'thread-legacy-pending', NULL, 'message-legacy-pending',
          '2026-08-19T00:00:03.000Z', '2026-08-19T00:00:03.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_files_json
        ) VALUES (
          'thread-legacy-pending', NULL, 'message-legacy-pending', NULL, 'pending',
          '2026-08-19T00:00:03.000Z', NULL, NULL, '[]'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          ('event-keep', 'thread', 'thread-keep', 1, 'thread.created',
            '2026-08-19T00:00:00.000Z', 'system', '{}', '{}'),
          ('event-remove', 'thread', 'thread-keep', 2, 'thread.turn-diff-completed',
            '2026-08-19T00:00:01.000Z', 'system', '{}', '{}')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          sequence, created_at
        ) VALUES
          ('activity-keep', 'thread-keep', 'turn-keep', 'info', 'session.warning',
            'Keep', '{}', 1, '2026-08-19T00:00:00.000Z'),
          ('activity-remove', 'thread-keep', 'turn-keep', 'info', 'checkpoint.captured',
            'Remove', '{}', 2, '2026-08-19T00:00:01.000Z')
      `;
      yield* sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id, from_turn_count, to_turn_count, diff, created_at
        ) VALUES ('thread-keep', 0, 1, 'diff', '2026-08-19T00:00:01.000Z')
      `;
      yield* sql`
        INSERT OR REPLACE INTO projection_state (
          projector, last_applied_sequence, updated_at
        ) VALUES ('projection.checkpoints', 2, '2026-08-19T00:00:02.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 137 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_turns') ORDER BY cid
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "thread_id",
          "turn_id",
          "provider_turn_id",
          "pending_message_id",
          "assistant_message_id",
          "state",
          "requested_at",
          "started_at",
          "completed_at",
        ],
      );
      const turns = yield* sql<{
        readonly thread_id: string;
        readonly turn_id: string;
        readonly provider_turn_id: string | null;
        readonly pending_message_id: string | null;
        readonly assistant_message_id: string | null;
        readonly state: string;
        readonly requested_at: string | null;
        readonly started_at: string | null;
        readonly completed_at: string | null;
      }>`
        SELECT thread_id, turn_id, provider_turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at
        FROM projection_turns
        ORDER BY thread_id
      `;
      assert.deepInclude(turns, {
        thread_id: "thread-keep",
        turn_id: "turn-keep",
        provider_turn_id: "turn-keep",
        pending_message_id: "message-user",
        assistant_message_id: "message-assistant",
        state: "completed",
        requested_at: "2026-08-19T00:00:00.000Z",
        started_at: "2026-08-19T00:00:01.000Z",
        completed_at: "2026-08-19T00:00:02.000Z",
      });
      const migratedPending = turns.find((turn) => turn.thread_id === "thread-legacy-pending");
      assert.match(migratedPending?.turn_id ?? "", /^legacy-pending:\d+$/);
      assert.equal(migratedPending?.provider_turn_id, null);
      assert.equal(migratedPending?.state, "pending");
      const migratedRecovery = yield* sql<{
        readonly turnId: string;
        readonly turnIdNotNull: number;
      }>`
        SELECT recovery.turn_id AS "turnId", columns."notnull" AS "turnIdNotNull"
        FROM restart_turn_recoveries AS recovery
        JOIN pragma_table_info('restart_turn_recoveries') AS columns
          ON columns.name = 'turn_id'
        WHERE recovery.thread_id = 'thread-legacy-pending'
      `;
      assert.deepStrictEqual(migratedRecovery, [
        { turnId: "legacy-recovery:thread-legacy-pending", turnIdNotNull: 1 },
      ]);

      const remainingEvents = yield* sql<{ readonly eventId: string }>`
        SELECT event_id AS "eventId" FROM orchestration_events ORDER BY event_id
      `;
      assert.deepStrictEqual(remainingEvents, [{ eventId: "event-keep" }]);
      const remainingActivities = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        ORDER BY activity_id
      `;
      assert.deepStrictEqual(remainingActivities, [{ activityId: "activity-keep" }]);

      const removedObjects = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema
        WHERE name IN ('checkpoint_diff_blobs', 'idx_checkpoint_diff_blobs_thread_to_turn')
      `;
      assert.deepStrictEqual(removedObjects, []);
      const removedProjector = yield* sql`
        SELECT projector FROM projection_state WHERE projector = 'projection.checkpoints'
      `;
      assert.deepStrictEqual(removedProjector, []);
      const turnIndex = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_list('projection_turns')
        WHERE name IN (
          'idx_projection_turns_thread_requested',
          'idx_projection_turns_thread_provider_turn'
        )
        ORDER BY name
      `;
      assert.deepStrictEqual(turnIndex, [
        { name: "idx_projection_turns_thread_provider_turn" },
        { name: "idx_projection_turns_thread_requested" },
      ]);
    }),
  );
});

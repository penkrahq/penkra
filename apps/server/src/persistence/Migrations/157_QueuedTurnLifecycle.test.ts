import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("157_QueuedTurnLifecycle", (it) => {
  it.effect("migrates admitted starts and rolls queued turns into sidebar work status", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 156 });
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          'folder-turn-lifecycle', 'Folder', NULL,
          '{"provider":"codex","model":"gpt-5.6-sol"}', '[]',
          '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-turn-lifecycle', 'folder-turn-lifecycle', 'Thread',
          '{"provider":"codex","model":"gpt-5.6-sol"}', 'full-access',
          '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state,
          requested_at, started_at, completed_at
        ) VALUES (
          'thread-turn-lifecycle', 'turn-admitted', 'message-admitted', 'pending',
          '2026-09-05T00:00:01.000Z', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-queued-before-157', 'thread', 'thread-turn-lifecycle', 1,
          'thread.turn-queued', '2026-09-05T00:00:02.000Z',
          'command-queued-before-157', 'system',
          '{"threadId":"thread-turn-lifecycle","messageId":"message-queued-before-157","turnId":"turn-queued-before-157","dispatchMode":"queue","runtimeMode":"full-access","createdAt":"2026-09-05T00:00:02.000Z"}',
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO queued_turn_promotions (
          queued_event_sequence, thread_id, message_id, dispatch_mode, state,
          attempt_count, created_at, updated_at
        )
        SELECT sequence, 'thread-turn-lifecycle', 'message-queued-before-157',
          'queue', 'queued', 0,
          '2026-09-05T00:00:02.000Z', '2026-09-05T00:00:02.000Z'
        FROM orchestration_events WHERE event_id = 'event-queued-before-157'
      `;

      yield* runMigrations({ toMigrationInclusive: 157 });
      const admitted = yield* sql<{ readonly state: string }>`
        SELECT state FROM projection_turns
        WHERE thread_id = 'thread-turn-lifecycle' AND turn_id = 'turn-admitted'
      `;
      assert.strictEqual(admitted[0]?.state, "running");
      const queued = yield* sql<{ readonly state: string; readonly messageId: string }>`
        SELECT state, pending_message_id AS "messageId" FROM projection_turns
        WHERE thread_id = 'thread-turn-lifecycle' AND turn_id = 'turn-queued-before-157'
      `;
      assert.deepStrictEqual(queued, [{ state: "queued", messageId: "message-queued-before-157" }]);

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state,
          requested_at, started_at, completed_at
        ) VALUES (
          'thread-turn-lifecycle', 'turn-queued', 'message-queued', 'queued',
          '2026-09-05T00:00:03.000Z', NULL, NULL
        )
      `;
      const status = yield* sql<{ readonly status: string }>`
        SELECT work_status AS status FROM projection_threads
        WHERE thread_id = 'thread-turn-lifecycle'
      `;
      assert.strictEqual(status[0]?.status, "running");
    }),
  );
});

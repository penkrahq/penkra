import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("156_ActiveTurnProjectionSemantics", (it) => {
  it.effect("keeps sidebar status on the runtime-active turn across newer history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 155 });
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          'folder-active-status', 'Folder', NULL,
          '{"provider":"codex","model":"gpt-5.6-sol"}', '[]',
          '2026-08-29T05:00:00.000Z', '2026-08-29T05:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, runtime_mode,
          last_activity_at, last_visited_at, created_at, updated_at
        ) VALUES (
          'thread-active-status', 'folder-active-status', 'Thread',
          '{"provider":"codex","model":"gpt-5.6-sol"}', 'full-access',
          '2026-08-29T06:14:25.100Z', '2026-08-29T06:14:25.100Z',
          '2026-08-29T05:00:00.000Z', '2026-08-29T06:14:25.100Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, state,
          requested_at, started_at, completed_at
        ) VALUES (
          'thread-active-status', 'canonical-active', 'provider-active', 'running',
          '2026-08-29T05:42:53.000Z', '2026-08-29T06:14:25.053Z', NULL
        ), (
          'thread-active-status', 'newer-terminal', NULL, 'completed',
          '2026-08-29T06:14:22.782Z', '2026-08-29T06:14:25.002Z',
          '2026-08-29T06:14:25.002Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, runtime_mode,
          active_turn_id, last_error, updated_at
        ) VALUES (
          'thread-active-status', 'running', 'codex', 'full-access',
          'provider-active', NULL, '2026-08-29T06:14:25.053Z'
        )
      `;

      const before = yield* sql<{ readonly status: string }>`
        SELECT work_status AS status
        FROM projection_threads
        WHERE thread_id = 'thread-active-status'
      `;
      assert.strictEqual(before[0]?.status, "idle");

      yield* runMigrations({ toMigrationInclusive: 156 });
      const migrated = yield* sql<{ readonly status: string }>`
        SELECT work_status AS status
        FROM projection_threads
        WHERE thread_id = 'thread-active-status'
      `;
      assert.strictEqual(migrated[0]?.status, "running");

      yield* sql`
        UPDATE projection_thread_sessions
        SET status = 'ready', active_turn_id = NULL, updated_at = '2026-08-29T06:15:00.000Z'
        WHERE thread_id = 'thread-active-status'
      `;
      const settled = yield* sql<{ readonly status: string }>`
        SELECT work_status AS status
        FROM projection_threads
        WHERE thread_id = 'thread-active-status'
      `;
      assert.strictEqual(settled[0]?.status, "idle");
    }),
  );
});

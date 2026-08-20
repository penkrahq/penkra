import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

interface SidebarRollupRow {
  readonly workStatus: string;
  readonly preview: string;
  readonly lastActivityAt: string;
}

layer("141_ThreadSidebarRollups", (it) => {
  it.effect("maintains preview, activity time, and indexed work-state transitions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 140 });
      const startedAt = "2026-08-19T00:00:01.000Z";
      const completedAt = "2026-08-19T00:00:03.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES ('project-1', 'folder', 'Project', '/workspace', NULL, '[]', ${startedAt}, ${startedAt})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES ('thread-1', 'project-1', 'Thread', '{"provider":"codex","model":"gpt-5.5"}',
                  'full-access', ${startedAt}, ${startedAt})
      `;
      yield* runMigrations({ toMigrationInclusive: 141 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, applied_len, source, created_at, updated_at
        ) VALUES ('message-1', 'thread-1', 'assistant', ${"x".repeat(260)}, 0, 260,
                  'provider', ${startedAt}, ${startedAt})
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, state, requested_at, started_at, completed_at
        ) VALUES ('thread-1', 'turn-1', 'provider-turn-1', 'running', ${startedAt}, ${startedAt}, NULL)
      `;
      let rows = yield* sql<SidebarRollupRow>`
        SELECT work_status AS "workStatus", last_message_preview AS preview,
               last_activity_at AS "lastActivityAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows[0]?.workStatus, "running");
      assert.strictEqual(rows[0]?.preview.length, 240);
      assert.strictEqual(rows[0]?.lastActivityAt, startedAt);

      yield* sql`
        UPDATE projection_turns SET state = 'completed', completed_at = ${completedAt}
        WHERE thread_id = 'thread-1' AND turn_id = 'turn-1'
      `;
      yield* sql`
        UPDATE projection_thread_messages SET updated_at = ${completedAt}
        WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `;
      rows = yield* sql<SidebarRollupRow>`
        SELECT work_status AS "workStatus", last_message_preview AS preview,
               last_activity_at AS "lastActivityAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows[0]?.workStatus, "done");
      yield* sql`
        UPDATE projection_threads SET last_visited_at = ${completedAt}
        WHERE thread_id = 'thread-1'
      `;
      const settled = yield* sql<{ readonly workStatus: string }>`
        SELECT work_status AS "workStatus" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(settled[0]?.workStatus, "idle");

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_projection_threads_sidebar_status_activity'
      `;
      assert.lengthOf(indexes, 1);
      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM projection_threads
        WHERE deleted_at IS NULL AND archived_at IS NULL AND work_status = 'done'
        ORDER BY last_activity_at DESC, thread_id
      `;
      assert.isTrue(
        queryPlan.some(({ detail }) =>
          detail.includes("idx_projection_threads_sidebar_status_activity"),
        ),
      );
    }),
  );
});

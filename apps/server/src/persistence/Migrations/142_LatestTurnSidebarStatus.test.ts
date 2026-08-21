import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("142_LatestTurnSidebarStatus", (it) => {
  it.effect("ignores an older orphan when the latest turn is terminal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 141 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          'project-latest-status', 'folder', 'Project', '/workspace', NULL,
          '[]', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          last_activity_at, created_at, updated_at
        ) VALUES (
          'thread-latest-status', 'project-latest-status', 'Thread',
          '{"provider":"codex","model":"gpt-5.6-sol"}', 'full-access',
          '2026-08-20T00:00:04.000Z', '2026-08-20T00:00:00.000Z',
          '2026-08-20T00:00:04.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at
        ) VALUES
          (
            'thread-latest-status', 'turn-old-orphan', 'running',
            '2026-08-20T00:00:01.000Z', '2026-08-20T00:00:01.000Z', NULL
          ),
          (
            'thread-latest-status', 'turn-latest-complete', 'completed',
            '2026-08-20T00:00:02.000Z', '2026-08-20T00:00:02.000Z',
            '2026-08-20T00:00:04.000Z'
          )
      `;
      const before = yield* sql<{ readonly status: string }>`
        SELECT work_status AS status FROM projection_threads
        WHERE thread_id = 'thread-latest-status'
      `;
      assert.strictEqual(before[0]?.status, "done");

      // Reproduce the shipped 141 defect, then prove the new migration repairs it.
      yield* sql`UPDATE projection_threads SET work_status = 'running' WHERE thread_id = 'thread-latest-status'`;
      yield* runMigrations({ toMigrationInclusive: 142 });
      const repaired = yield* sql<{ readonly status: string }>`
        SELECT work_status AS status FROM projection_threads
        WHERE thread_id = 'thread-latest-status'
      `;
      assert.strictEqual(repaired[0]?.status, "done");

      yield* sql`
        UPDATE projection_threads SET last_visited_at = '2026-08-20T00:00:04.000Z'
        WHERE thread_id = 'thread-latest-status'
      `;
      // An update to the older poisoned row must not resurrect the spinner.
      yield* sql`
        UPDATE projection_turns SET started_at = '2026-08-20T00:00:03.000Z'
        WHERE thread_id = 'thread-latest-status' AND turn_id = 'turn-old-orphan'
      `;
      const settled = yield* sql<{ readonly status: string }>`
        SELECT work_status AS status FROM projection_threads
        WHERE thread_id = 'thread-latest-status'
      `;
      assert.strictEqual(settled[0]?.status, "idle");
    }),
  );
});

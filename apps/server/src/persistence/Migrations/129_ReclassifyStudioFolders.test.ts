import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("129_ReclassifyStudioFolders", (it) => {
  it.effect("preserves Studio containers and their threads as ordinary folders", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 128 });
      const now = "2026-08-19T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, kind
        ) VALUES ('studio-folder', 'Studio', '/tmp/studio', NULL, '[]', ${now}, ${now}, 'studio')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, space_id, title, model_selection_json,
          runtime_mode, env_mode, created_at, updated_at
        ) VALUES (
          'studio-thread', 'studio-folder', 'space-default', 'Kept thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'local', ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'legacy-output', 'studio-thread', NULL, 'info', 'studio.outputs.captured',
          'Captured output', '{}', ${now}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 129 });
      const rows = yield* sql<{ readonly kind: string; readonly threadCount: number }>`
        SELECT projects.kind, COUNT(threads.thread_id) AS "threadCount"
        FROM projection_projects AS projects
        LEFT JOIN projection_threads AS threads ON threads.project_id = projects.project_id
        WHERE projects.project_id = 'studio-folder'
        GROUP BY projects.kind
      `;
      assert.deepStrictEqual(rows, [{ kind: "project", threadCount: 1 }]);
      const activities = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM projection_thread_activities WHERE activity_id = 'legacy-output'
      `;
      assert.deepStrictEqual(activities, [{ kind: "legacy.outputs.captured" }]);
    }),
  );
});

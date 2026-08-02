import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("092_RemoveProjectionThreadWorktreePath", (it) => {
  it.effect("moves the legacy worktree path into working_directory before dropping it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'folder-1', 'project', 'Folder', '/repo', '[]', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, env_mode, branch,
          worktree_path, working_directory, create_branch_flow_completed, created_at, updated_at
        ) VALUES (
          'thread-1', 'folder-1', 'Thread', 'full-access', 'default', 'worktree', 'feature',
          '/repo/.worktrees/feature', NULL, 0, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 92 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      assert.notInclude(
        columns.map((column) => column.name),
        "worktree_path",
      );
      const rows = yield* sql<{ readonly working_directory: string | null }>`
        SELECT working_directory FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows[0]?.working_directory, "/repo/.worktrees/feature");
    }),
  );
});

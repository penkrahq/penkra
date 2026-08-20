import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("139_RemoveGitThreadMetadata", (it) => {
  it.effect("drops built-in Git metadata without changing Thread identity or workspace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 138 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'folder', 'Project', '/workspace', NULL, '[]',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          working_directory, env_mode, branch, associated_worktree_path,
          associated_worktree_branch, associated_worktree_ref,
          create_branch_flow_completed, last_known_pr_json,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread', '{}', 'full-access', '/workspace',
          'worktree', 'feature', '/worktree', 'feature', 'abc', 1, '{}',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 139 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      const names = columns.map(({ name }) => name);
      for (const removed of [
        "env_mode",
        "branch",
        "associated_worktree_path",
        "associated_worktree_branch",
        "associated_worktree_ref",
        "create_branch_flow_completed",
        "last_known_pr_json",
      ]) {
        assert.notInclude(names, removed);
      }
      assert.include(names, "working_directory");
      const rows = yield* sql<{ readonly threadId: string; readonly workingDirectory: string }>`
        SELECT thread_id AS "threadId", working_directory AS "workingDirectory"
        FROM projection_threads
      `;
      assert.deepStrictEqual(rows, [{ threadId: "thread-1", workingDirectory: "/workspace" }]);
    }),
  );
});

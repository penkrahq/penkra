import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const removedColumns = [
  "env_mode",
  "branch",
  "associated_worktree_path",
  "associated_worktree_branch",
  "associated_worktree_ref",
  "create_branch_flow_completed",
  "last_known_pr_json",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  const existingNames = new Set(existing.map((column) => column.name));
  for (const column of removedColumns) {
    if (existingNames.has(column)) {
      yield* sql.unsafe(`ALTER TABLE projection_threads DROP COLUMN ${column}`);
    }
  }
});

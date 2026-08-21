import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN archived_at TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_archive
    ON projection_projects(archived_at, space_id, sidebar_sort_order, project_id)
  `;
});

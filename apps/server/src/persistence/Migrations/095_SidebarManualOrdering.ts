// Purpose: Persists stable manual ordering for folders and threads in the sidebar.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `;
  if (!projectColumns.some((column) => column.name === "sidebar_sort_order")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN sidebar_sort_order INTEGER NOT NULL DEFAULT 0
    `;
  }
  const threadColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  if (!threadColumns.some((column) => column.name === "sidebar_sort_order")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sidebar_sort_order INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_sidebar_order
    ON projection_projects(space_id, is_pinned DESC, sidebar_sort_order, created_at DESC, project_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_sidebar_order
    ON projection_threads(project_id, space_id, parent_thread_id, is_pinned DESC, sidebar_sort_order, created_at DESC, thread_id)
  `;
});

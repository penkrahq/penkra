import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The product contract has used Folder/FolderId since migration 149. Complete
// that cutover in the current read model so new code and diagnostics no longer
// carry the retired Project vocabulary. Historical migrations remain unchanged.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_projects RENAME TO projection_folders`;
  yield* sql`ALTER TABLE projection_folders RENAME COLUMN project_id TO folder_id`;
  yield* sql`ALTER TABLE projection_threads RENAME COLUMN project_id TO folder_id`;
  yield* sql`
    ALTER TABLE space_navigation_state
    RENAME COLUMN last_project_id_by_space_json TO last_folder_id_by_space_json
  `;

  yield* sql`DROP INDEX IF EXISTS idx_projection_projects_updated_at`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_projects_space_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_projects_sidebar_order`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_projects_archive`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_sidebar_order`;

  yield* sql`
    CREATE INDEX idx_projection_folders_updated_at
    ON projection_folders(updated_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_folders_space_id
    ON projection_folders(space_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_folders_sidebar_order
    ON projection_folders(space_id, is_pinned DESC, sidebar_sort_order, created_at DESC, folder_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_folders_archive
    ON projection_folders(archived_at, space_id, sidebar_sort_order, folder_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_folder_id
    ON projection_threads(folder_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_sidebar_order
    ON projection_threads(folder_id, space_id, parent_thread_id, is_pinned DESC, sidebar_sort_order, created_at DESC, thread_id)
  `;
});

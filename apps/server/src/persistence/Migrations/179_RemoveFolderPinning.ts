// FILE: 179_RemoveFolderPinning.ts
// Purpose: Remove the shipped folder pin column and its index key.
// Layer: SQLite migration

import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_projection_folders_sidebar_order`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_folders)`;
  // Migration lineage replay can apply this over its own post-state.
  if (columns.some((column) => column.name === "is_pinned"))
    yield* sql`ALTER TABLE projection_folders DROP COLUMN is_pinned`;
  yield* sql`
    CREATE INDEX idx_projection_folders_sidebar_order
    ON projection_folders(space_id, sidebar_sort_order, created_at DESC, folder_id)
  `;
});

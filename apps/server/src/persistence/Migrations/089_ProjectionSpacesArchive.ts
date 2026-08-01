// Purpose: Adds reversible Space archival without changing project or thread assignments.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_spaces", "archived_at"))) {
    yield* sql`ALTER TABLE projection_spaces ADD COLUMN archived_at TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_spaces_visible_order
    ON projection_spaces(deleted_at, archived_at, sort_order, space_id)
  `;
});

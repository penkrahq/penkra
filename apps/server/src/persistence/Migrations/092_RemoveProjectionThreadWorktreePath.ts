// Purpose: Makes working_directory the single physical path stored for a thread.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_threads", "worktree_path"))) return;

  yield* sql`
    UPDATE projection_threads
    SET working_directory = COALESCE(working_directory, worktree_path)
    WHERE worktree_path IS NOT NULL
  `;
  yield* sql`ALTER TABLE projection_threads DROP COLUMN worktree_path`;
});

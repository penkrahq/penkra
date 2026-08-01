// Purpose: Persists direct Space ownership for loose chat threads. Threads
// backed by a project continue to inherit their Space from that project.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_threads", "space_id"))) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN space_id TEXT`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_space_id
    ON projection_threads(space_id)
  `;
});

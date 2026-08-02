// Purpose: Persists the selected Space and its most recently opened contexts.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS space_navigation_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      active_space_id TEXT,
      last_thread_id_by_space_json TEXT NOT NULL DEFAULT '{}',
      last_project_id_by_space_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `;
});

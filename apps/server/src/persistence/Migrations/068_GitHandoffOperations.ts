import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { tableExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 97 gives this operation its final product name. A reconciled
  // migration replay must not recreate the retired table beside it.
  if (yield* tableExists(sql, "git_thread_environment_operations")) {
    return;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS git_handoff_operations (
      command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      input_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('pending', 'git_applied', 'completed', 'uncertain')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_git_handoff_operations_recovery
    ON git_handoff_operations(phase, updated_at, command_id)
  `;
});

// FILE: 097_RenameGitThreadEnvironmentOperations.ts
// Purpose: Separates Git environment switching from the removed provider Handoff concept.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { tableExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasFinalTable = yield* tableExists(sql, "git_thread_environment_operations");
  const hasRetiredTable = yield* tableExists(sql, "git_handoff_operations");

  if (!hasFinalTable && hasRetiredTable) {
    yield* sql`
      ALTER TABLE git_handoff_operations
      RENAME TO git_thread_environment_operations
    `;
  }

  if (yield* tableExists(sql, "git_thread_environment_operations")) {
    yield* sql`DROP INDEX IF EXISTS idx_git_handoff_operations_recovery`;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_git_thread_environment_operations_recovery
      ON git_thread_environment_operations(phase, updated_at, command_id)
    `;
  }
});

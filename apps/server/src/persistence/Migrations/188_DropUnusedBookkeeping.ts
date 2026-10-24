// FILE: 188_DropUnusedBookkeeping.ts
// Purpose: Remove journals and pins whose production features have been deleted.

import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE provider_native_fork_operations`;
  yield* sql`DROP TABLE git_thread_environment_operations`;
  yield* sql`DROP TABLE project_pull_request_pins`;
});

// FILE: 184_StartupRunningThreadsIndex.ts
// Purpose: Index the running rows included in the startup navigation snapshot.

import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_threads_running_live ON threads(state, id) WHERE deleted_at IS NULL AND archived_at IS NULL`;
});

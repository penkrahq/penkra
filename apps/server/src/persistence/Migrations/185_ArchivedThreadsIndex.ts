// FILE: 185_ArchivedThreadsIndex.ts
// Purpose: Index the newest-first keyset pages on the Archive screen.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_threads_archived ON threads(archived_at DESC, id DESC) WHERE deleted_at IS NULL AND archived_at IS NOT NULL`;
});

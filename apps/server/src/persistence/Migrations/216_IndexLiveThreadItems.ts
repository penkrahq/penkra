import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

// Settling a turn finds its items still running or streaming. Without this the
// lookup read every item in the thread inside the turn-end write, holding the
// database for seconds on long threads (operator, 2026-11-21).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_thread_items_live ON thread_items(thread_id,seq DESC) WHERE status IN ('running','streaming')`;
});

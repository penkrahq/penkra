import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_thread_items_latest_turn ON thread_items(thread_id,seq DESC) WHERE kind='turn'`;
});

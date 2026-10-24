import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_thread_items_open_question ON thread_items(thread_id,seq DESC) WHERE kind='question' AND status='open'`;
});

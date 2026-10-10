import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_threads_deck_order
    ON threads(deck_id, deck_sort_order, id) WHERE deleted_at IS NULL`;
});

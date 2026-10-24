import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_pending_interactions DROP COLUMN decision`;
  yield* Effect.logInfo("Removed the obsolete approval decision column");
});

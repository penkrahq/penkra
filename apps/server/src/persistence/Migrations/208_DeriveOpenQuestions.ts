import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads DROP COLUMN open_question_count`;
  yield* Effect.logInfo("Removed stored open-question counter; reads derive question state");
});

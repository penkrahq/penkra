import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN saved TEXT NOT NULL DEFAULT '[]'`;
});

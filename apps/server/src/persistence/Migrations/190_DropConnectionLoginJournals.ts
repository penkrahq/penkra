// FILE: 190_DropConnectionLoginJournals.ts
// Purpose: Remove retired sign-in and connection-operation journals.

import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE provider_connection_logins`;
  yield* sql`DROP TABLE provider_connection_operations`;
});

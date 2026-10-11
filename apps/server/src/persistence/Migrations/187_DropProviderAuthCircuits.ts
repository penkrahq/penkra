// FILE: 187_DropProviderAuthCircuits.ts
// Purpose: Auth blocks now live only in the shared process-local service.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE provider_auth_circuits`;
});

// FILE: 189_DropUnusedDiagnosticsAndRateLimits.ts
// Purpose: Retire unused diagnostic and rate-limit storage; usage accounting stays.

import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE operational_diagnostics`;
  yield* sql`DROP TABLE connection_rate_limits`;
});

// Command receipts are queried only by their command_id primary key. These
// secondary indexes duplicated every receipt without serving a runtime read.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_aggregate`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_sequence`;
});

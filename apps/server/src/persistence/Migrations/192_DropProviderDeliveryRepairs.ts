import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM provider_intent_outbox_reconciliations`;
  yield* sql`DROP TABLE provider_intent_outbox_reconciliations`;
  yield* Effect.logInfo("Removed provider delivery repair journal", {
    removedReconciliations: row!.count,
  });
});

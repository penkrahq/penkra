import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM provider_runtime_event_consumers`;
  yield* sql`DROP TABLE provider_runtime_event_consumers`;
  yield* Effect.logInfo("Removed the unused global runtime consumer ledger", {
    removedConsumers: row!.count,
  });
});

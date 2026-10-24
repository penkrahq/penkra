import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const counts = (yield* sql<{ switches: number; deletions: number }>`SELECT
    (SELECT COUNT(*) FROM provider_thread_switch_operations) AS switches,
    (SELECT COUNT(*) FROM provider_native_state_deletions) AS deletions`)[0]!;
  yield* sql`DROP TRIGGER projection_threads_enqueue_native_state_deletion`;
  yield* sql`DROP TABLE provider_thread_switch_operations`;
  yield* sql`DROP TABLE provider_native_state_deletions`;
  yield* Effect.logInfo("Removed native-state operation journals", counts);
});

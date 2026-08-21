import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Cover canonical-operation suppression without requiring a provider prefix. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_operations_activity_identity
    ON operations(
      thread_id,
      COALESCE(turn_id, ''),
      provider_operation_id
    )
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS operations (
      operation_id TEXT PRIMARY KEY,
      provider_operation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      provider TEXT NOT NULL,
      item_type TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('started', 'running', 'completed', 'failed', 'cancelled', 'aborted', 'interrupted')
      ),
      input_json TEXT,
      detail_json TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_source_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_provider_identity
    ON operations(provider, thread_id, COALESCE(turn_id, ''), provider_operation_id)
  `;
});

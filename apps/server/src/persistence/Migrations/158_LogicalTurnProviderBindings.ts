import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_projection_turns_thread_provider_turn`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_provider_turn
    ON projection_turns(thread_id, provider_turn_id)
    WHERE provider_turn_id IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_provider_bindings (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, provider_turn_id),
      FOREIGN KEY (thread_id, turn_id)
        REFERENCES projection_turns(thread_id, turn_id)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_provider_bindings_lookup
    ON projection_turn_provider_bindings(thread_id, turn_id, bound_at)
  `;
  yield* sql`
    INSERT INTO projection_turn_provider_bindings (
      thread_id, turn_id, provider_turn_id, bound_at
    )
    SELECT thread_id, turn_id, provider_turn_id, COALESCE(started_at, requested_at)
    FROM projection_turns
    WHERE provider_turn_id IS NOT NULL
    ON CONFLICT (thread_id, turn_id, provider_turn_id) DO NOTHING
  `;
});

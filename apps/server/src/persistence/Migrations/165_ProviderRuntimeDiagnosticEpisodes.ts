import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_runtime_diagnostic_episodes (
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      diagnostic_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      episode INTEGER NOT NULL CHECK (episode > 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'resolved')),
      active_event_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, provider, diagnostic_key)
    )
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The intent payload is copied into the outbox in the command transaction.
// Retaining the orchestration journal is therefore not required for an
// unfinished provider job to survive event-tail collection.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migratedAt = new Date().toISOString();
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_intent_outbox_cutover (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      legacy_through_sequence INTEGER NOT NULL CHECK (legacy_through_sequence >= 0),
      legacy_drained_at TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO provider_intent_outbox_cutover (
      id, legacy_through_sequence, legacy_drained_at, created_at
    )
    SELECT 1, COALESCE(MAX(sequence), 0), NULL, ${migratedAt}
    FROM orchestration_events
    WHERE 1 = 1
    ON CONFLICT (id) DO NOTHING
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_intent_outbox (
      event_sequence INTEGER PRIMARY KEY CHECK (event_sequence > 0),
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      lane_key TEXT NOT NULL,
      binding_revision INTEGER,
      lifecycle_generation TEXT,
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'inflight', 'retry', 'succeeded', 'dead', 'uncertain', 'abandoned')
      ),
      claim_owner TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      claimed_at TEXT,
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((state = 'inflight') = (claim_owner IS NOT NULL)),
      CHECK ((claim_owner IS NULL) = (claim_expires_at IS NULL))
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_intent_outbox_lane_pending
    ON provider_intent_outbox(lane_key, event_sequence)
    WHERE state IN ('pending', 'retry', 'inflight', 'uncertain', 'dead')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_intent_outbox_ready
    ON provider_intent_outbox(state, event_sequence)
    WHERE state IN ('pending', 'retry')
  `;
});

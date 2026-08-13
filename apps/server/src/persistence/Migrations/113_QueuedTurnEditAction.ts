import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface TableDefinition {
  readonly sql: string | null;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const definitions = yield* sql<TableDefinition>`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'queued_turn_promotions'
  `;

  if (definitions[0]?.sql?.includes("'edit'")) return;

  yield* sql`
    CREATE TABLE queued_turn_promotions_with_edit (
      queued_event_sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      dispatch_mode TEXT NOT NULL CHECK (dispatch_mode IN ('queue', 'steer')),
      state TEXT NOT NULL CHECK (state IN ('queued', 'promoting', 'promoted', 'cancelled')),
      claim_owner TEXT,
      claimed_at TEXT,
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      promoted_at TEXT,
      action_kind TEXT CHECK (action_kind IN ('cancel', 'edit', 'steer')),
      action_event_id TEXT,
      FOREIGN KEY (queued_event_sequence) REFERENCES orchestration_events(sequence) ON DELETE RESTRICT
    )
  `;
  yield* sql`
    INSERT INTO queued_turn_promotions_with_edit (
      queued_event_sequence, thread_id, message_id, dispatch_mode, state,
      claim_owner, claimed_at, claim_expires_at, attempt_count, created_at,
      updated_at, promoted_at, action_kind, action_event_id
    )
    SELECT
      queued_event_sequence, thread_id, message_id, dispatch_mode, state,
      claim_owner, claimed_at, claim_expires_at, attempt_count, created_at,
      updated_at, promoted_at, action_kind, action_event_id
    FROM queued_turn_promotions
  `;
  yield* sql`DROP TABLE queued_turn_promotions`;
  yield* sql`ALTER TABLE queued_turn_promotions_with_edit RENAME TO queued_turn_promotions`;

  yield* sql`
    CREATE INDEX idx_queued_turn_promotions_thread_state_order
    ON queued_turn_promotions(thread_id, state, dispatch_mode, queued_event_sequence)
  `;
  yield* sql`
    CREATE INDEX idx_queued_turn_promotions_state_expiry
    ON queued_turn_promotions(state, claim_expires_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_queued_turn_promotions_active_message
    ON queued_turn_promotions(thread_id, message_id)
    WHERE state IN ('queued', 'promoting')
  `;
});

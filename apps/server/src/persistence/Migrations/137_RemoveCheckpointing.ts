import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const REMOVED_EVENT_TYPES = [
  "thread.checkpoint-revert-requested",
  "thread.turn-diff-completed",
] as const;

const REMOVED_ACTIVITY_KINDS = [
  "checkpoint.baseline.captured",
  "checkpoint.capture.failed",
  "checkpoint.captured",
  "checkpoint.diff.finalized",
  "checkpoint.revert.failed",
  "checkpoint.revert.started",
  "checkpoint.revert.succeeded",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventCountRows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM orchestration_events
    WHERE event_type IN ${sql.in(REMOVED_EVENT_TYPES)}
  `;
  const activityCountRows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM projection_thread_activities
    WHERE kind IN ${sql.in(REMOVED_ACTIVITY_KINDS)}
  `;
  const eventCount = Number(eventCountRows[0]?.count ?? 0);
  const activityCount = Number(activityCountRows[0]?.count ?? 0);
  const pendingTurnCountRows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM projection_turns WHERE turn_id IS NULL
  `;
  const mintedPendingTurnCount = Number(pendingTurnCountRows[0]?.count ?? 0);
  const pendingRecoveryCountRows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM restart_turn_recoveries WHERE turn_id IS NULL
  `;
  const mintedRecoveryTurnCount = Number(pendingRecoveryCountRows[0]?.count ?? 0);

  yield* Effect.log("Removing checkpoint persistence").pipe(
    Effect.annotateLogs({
      removedEventCount: eventCount,
      removedActivityCount: activityCount,
      mintedPendingTurnCount,
      mintedRecoveryTurnCount,
    }),
  );

  yield* sql`
    DELETE FROM orchestration_events
    WHERE event_type IN ${sql.in(REMOVED_EVENT_TYPES)}
  `;
  yield* sql`
    DELETE FROM projection_thread_activities
    WHERE kind IN ${sql.in(REMOVED_ACTIVITY_KINDS)}
  `;
  yield* sql`DELETE FROM projection_state WHERE projector = 'projection.checkpoints'`;
  yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;

  // A completed migration set can be replayed by recovery/backup validation.
  // Remove later rollup triggers before rebuilding projection_turns; migration
  // 141 recreates them after the table has its final shape.
  yield* sql`DROP TRIGGER IF EXISTS projection_turns_sidebar_rollup_insert`;
  yield* sql`DROP TRIGGER IF EXISTS projection_turns_sidebar_rollup_update`;
  yield* sql`DROP TRIGGER IF EXISTS projection_threads_sidebar_rollup_update`;

  yield* sql`
    CREATE TABLE projection_turns_next (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_turn_id TEXT,
      pending_message_id TEXT,
      assistant_message_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;
  yield* sql`
    INSERT INTO projection_turns_next (
      thread_id,
      turn_id,
      provider_turn_id,
      pending_message_id,
      assistant_message_id,
      state,
      requested_at,
      started_at,
      completed_at
    )
    SELECT
      thread_id,
      COALESCE(turn_id, 'legacy-pending:' || rowid),
      turn_id,
      pending_message_id,
      assistant_message_id,
      state,
      requested_at,
      started_at,
      completed_at
    FROM projection_turns
  `;
  yield* sql`DROP TABLE projection_turns`;
  yield* sql`ALTER TABLE projection_turns_next RENAME TO projection_turns`;
  yield* sql`
    CREATE INDEX idx_projection_turns_thread_requested
    ON projection_turns(thread_id, requested_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_projection_turns_thread_provider_turn
    ON projection_turns(thread_id, provider_turn_id)
    WHERE provider_turn_id IS NOT NULL
  `;

  yield* sql`ALTER TABLE restart_turn_recoveries RENAME TO restart_turn_recoveries_v136`;
  yield* sql`
    CREATE TABLE restart_turn_recoveries (
      thread_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      message_id TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO restart_turn_recoveries (
      thread_id, turn_id, message_id, requested_at, updated_at
    )
    SELECT
      thread_id,
      COALESCE(turn_id, 'legacy-recovery:' || thread_id),
      message_id,
      requested_at,
      updated_at
    FROM restart_turn_recoveries_v136
  `;
  yield* sql`DROP TABLE restart_turn_recoveries_v136`;
});

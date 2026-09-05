import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const selectedTurnStateSql = `
  COALESCE((
    SELECT turn.state
    FROM projection_turns AS turn
    LEFT JOIN projection_thread_sessions AS session
      ON session.thread_id = turn.thread_id
    WHERE turn.thread_id = projection_threads.thread_id
    ORDER BY
      CASE
        WHEN session.status = 'running'
          AND session.active_turn_id IS NOT NULL
          AND (
            turn.turn_id = session.active_turn_id
            OR turn.provider_turn_id = session.active_turn_id
          )
          THEN 0
        ELSE 1
      END ASC,
      turn.requested_at DESC,
      turn.turn_id DESC
    LIMIT 1
  ), '')
`;

const recomputeStatusSql = `
  CASE
    WHEN pending_approval_count > 0 OR pending_user_input_count > 0 THEN 'attention'
    WHEN EXISTS (
      SELECT 1
      FROM projection_thread_sessions AS session
      WHERE session.thread_id = projection_threads.thread_id
        AND session.status = 'starting'
    ) THEN 'running'
    WHEN ${selectedTurnStateSql} IN ('queued', 'running') THEN 'running'
    WHEN ${selectedTurnStateSql} IN ('completed', 'interrupted', 'error')
      AND last_activity_at IS NOT NULL
      AND (last_visited_at IS NULL OR last_visited_at < last_activity_at) THEN 'done'
    ELSE 'idle'
  END
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `pending` was the old internal placeholder for an admitted direct start.
  // Direct starts are running from the caller's perspective even before the
  // provider assigns its native identity; queued admissions now have their own
  // explicit state.
  yield* sql`UPDATE projection_turns SET state = 'running' WHERE state = 'pending'`;
  // Earlier releases retained the durable queue separately and never projected
  // a canonical turn row for it. Backfill only still-active promotions; terminal
  // historical queue records do not need a pollable lifecycle handle.
  yield* sql`
    INSERT INTO projection_turns (
      thread_id, turn_id, provider_turn_id, pending_message_id,
      assistant_message_id, state, requested_at, started_at, completed_at
    )
    SELECT
      promotion.thread_id,
      COALESCE(
        json_extract(event.payload_json, '$.turnId'),
        'turn:' || event.command_id
      ),
      NULL,
      promotion.message_id,
      NULL,
      'queued',
      promotion.created_at,
      NULL,
      NULL
    FROM queued_turn_promotions AS promotion
    JOIN orchestration_events AS event
      ON event.sequence = promotion.queued_event_sequence
    WHERE promotion.state IN ('queued', 'promoting')
      AND event.event_type = 'thread.turn-queued'
    ON CONFLICT (thread_id, turn_id) DO UPDATE SET
      pending_message_id = excluded.pending_message_id,
      state = CASE
        WHEN projection_turns.state IN ('completed', 'interrupted', 'error', 'cancelled')
          THEN projection_turns.state
        ELSE 'queued'
      END,
      requested_at = excluded.requested_at,
      started_at = CASE
        WHEN projection_turns.state IN ('completed', 'interrupted', 'error', 'cancelled')
          THEN projection_turns.started_at
        ELSE NULL
      END,
      completed_at = CASE
        WHEN projection_turns.state IN ('completed', 'interrupted', 'error', 'cancelled')
          THEN projection_turns.completed_at
        ELSE NULL
      END
  `;
  yield* sql.unsafe(`UPDATE projection_threads SET work_status = ${recomputeStatusSql}`);

  yield* sql`DROP TRIGGER IF EXISTS projection_turns_sidebar_rollup_insert`;
  yield* sql`DROP TRIGGER IF EXISTS projection_turns_sidebar_rollup_update`;
  yield* sql`DROP TRIGGER IF EXISTS projection_threads_sidebar_rollup_update`;
  yield* sql`DROP TRIGGER IF EXISTS projection_thread_sessions_sidebar_rollup_insert`;
  yield* sql`DROP TRIGGER IF EXISTS projection_thread_sessions_sidebar_rollup_update`;
  yield* sql`DROP TRIGGER IF EXISTS projection_thread_sessions_sidebar_rollup_delete`;

  yield* sql.unsafe(`
    CREATE TRIGGER projection_turns_sidebar_rollup_insert
    AFTER INSERT ON projection_turns BEGIN
      UPDATE projection_threads SET work_status = ${recomputeStatusSql}
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER projection_turns_sidebar_rollup_update
    AFTER UPDATE ON projection_turns BEGIN
      UPDATE projection_threads SET work_status = ${recomputeStatusSql}
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER projection_threads_sidebar_rollup_update
    AFTER UPDATE OF pending_approval_count, pending_user_input_count, last_visited_at, last_activity_at
    ON projection_threads BEGIN
      UPDATE projection_threads SET work_status = ${recomputeStatusSql}
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER projection_thread_sessions_sidebar_rollup_insert
    AFTER INSERT ON projection_thread_sessions BEGIN
      UPDATE projection_threads SET work_status = ${recomputeStatusSql}
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER projection_thread_sessions_sidebar_rollup_update
    AFTER UPDATE ON projection_thread_sessions BEGIN
      UPDATE projection_threads SET work_status = ${recomputeStatusSql}
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER projection_thread_sessions_sidebar_rollup_delete
    AFTER DELETE ON projection_thread_sessions BEGIN
      UPDATE projection_threads SET work_status = ${recomputeStatusSql}
      WHERE thread_id = OLD.thread_id;
    END
  `);
});

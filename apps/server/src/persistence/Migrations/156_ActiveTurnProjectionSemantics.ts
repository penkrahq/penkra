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
    WHEN ${selectedTurnStateSql} IN ('pending', 'running') THEN 'running'
    WHEN ${selectedTurnStateSql} IN ('completed', 'interrupted', 'error')
      AND last_activity_at IS NOT NULL
      AND (last_visited_at IS NULL OR last_visited_at < last_activity_at) THEN 'done'
    ELSE 'idle'
  END
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

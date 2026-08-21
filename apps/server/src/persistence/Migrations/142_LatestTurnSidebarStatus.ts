import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const recomputeStatusSql = `
  CASE
    WHEN pending_approval_count > 0 OR pending_user_input_count > 0 THEN 'attention'
    WHEN COALESCE((
      SELECT turn.state
      FROM projection_turns AS turn
      WHERE turn.thread_id = projection_threads.thread_id
      ORDER BY turn.requested_at DESC, turn.turn_id DESC
      LIMIT 1
    ), '') IN ('pending', 'running') THEN 'running'
    WHEN COALESCE((
      SELECT turn.state
      FROM projection_turns AS turn
      WHERE turn.thread_id = projection_threads.thread_id
      ORDER BY turn.requested_at DESC, turn.turn_id DESC
      LIMIT 1
    ), '') IN ('completed', 'interrupted', 'error')
      AND last_activity_at IS NOT NULL
      AND (last_visited_at IS NULL OR last_visited_at < last_activity_at) THEN 'done'
    ELSE 'idle'
  END
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 141 used EXISTS over every historical turn. One orphaned older
  // pending/running row could therefore keep a visibly completed thread spinning
  // forever. Sidebar state follows the same latest-turn ordering as the canonical
  // read model; restart reconciliation separately settles every orphaned row.
  yield* sql.unsafe(`UPDATE projection_threads SET work_status = ${recomputeStatusSql}`);

  yield* sql`DROP TRIGGER IF EXISTS projection_turns_sidebar_rollup_insert`;
  yield* sql`DROP TRIGGER IF EXISTS projection_turns_sidebar_rollup_update`;
  yield* sql`DROP TRIGGER IF EXISTS projection_threads_sidebar_rollup_update`;

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
});

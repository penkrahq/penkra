import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const recomputeStatusSql = `
  CASE
    WHEN pending_approval_count > 0 OR pending_user_input_count > 0 THEN 'attention'
    WHEN EXISTS (
      SELECT 1 FROM projection_turns AS turn
      WHERE turn.thread_id = projection_threads.thread_id
        AND turn.state IN ('pending', 'running')
    ) THEN 'running'
    WHEN EXISTS (
      SELECT 1 FROM projection_turns AS turn
      WHERE turn.thread_id = projection_threads.thread_id
        AND turn.state IN ('completed', 'interrupted', 'error')
    ) AND last_activity_at IS NOT NULL
      AND (last_visited_at IS NULL OR last_visited_at < last_activity_at) THEN 'done'
    ELSE 'idle'
  END
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  const names = new Set(columns.map(({ name }) => name));
  if (!names.has("work_status")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN work_status TEXT NOT NULL DEFAULT 'idle'`;
  }
  if (!names.has("last_message_preview")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN last_message_preview TEXT`;
  }
  if (!names.has("last_activity_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN last_activity_at TEXT`;
  }

  yield* sql.unsafe(`
    UPDATE projection_threads
    SET last_message_preview = (
          SELECT substr(message.text, 1, 240)
          FROM projection_thread_messages AS message
          WHERE message.thread_id = projection_threads.thread_id
          ORDER BY COALESCE(message.sequence, -1) DESC, message.created_at DESC, message.message_id DESC
          LIMIT 1
        ),
        last_activity_at = MAX(
          COALESCE((
            SELECT MAX(message.updated_at) FROM projection_thread_messages AS message
            WHERE message.thread_id = projection_threads.thread_id
          ), ''),
          COALESCE((
            SELECT MAX(activity.created_at) FROM projection_thread_activities AS activity
            WHERE activity.thread_id = projection_threads.thread_id
          ), '')
        )
  `);
  yield* sql`UPDATE projection_threads SET last_activity_at = NULL WHERE last_activity_at = ''`;
  yield* sql.unsafe(`UPDATE projection_threads SET work_status = ${recomputeStatusSql}`);

  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_sidebar_rollup_insert
    AFTER INSERT ON projection_thread_messages BEGIN
      UPDATE projection_threads
      SET last_message_preview = substr(NEW.text, 1, 240),
          last_activity_at = MAX(COALESCE(last_activity_at, ''), NEW.updated_at)
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_sidebar_rollup_update
    AFTER UPDATE ON projection_thread_messages BEGIN
      UPDATE projection_threads
      SET last_message_preview = (
            SELECT substr(message.text, 1, 240)
            FROM projection_thread_messages AS message
            WHERE message.thread_id = NEW.thread_id
            ORDER BY COALESCE(message.sequence, -1) DESC, message.created_at DESC, message.message_id DESC
            LIMIT 1
          ),
          last_activity_at = MAX(COALESCE(last_activity_at, ''), NEW.updated_at)
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_thread_messages_sidebar_rollup_delete
    AFTER DELETE ON projection_thread_messages BEGIN
      UPDATE projection_threads
      SET last_message_preview = (
            SELECT substr(message.text, 1, 240)
            FROM projection_thread_messages AS message
            WHERE message.thread_id = OLD.thread_id
            ORDER BY COALESCE(message.sequence, -1) DESC, message.created_at DESC, message.message_id DESC
            LIMIT 1
          ),
          last_activity_at = MAX(
            COALESCE((SELECT MAX(message.updated_at) FROM projection_thread_messages AS message WHERE message.thread_id = OLD.thread_id), ''),
            COALESCE((SELECT MAX(activity.created_at) FROM projection_thread_activities AS activity WHERE activity.thread_id = OLD.thread_id), '')
          )
      WHERE thread_id = OLD.thread_id;
      UPDATE projection_threads SET last_activity_at = NULL
      WHERE thread_id = OLD.thread_id AND last_activity_at = '';
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_thread_activities_sidebar_rollup_insert
    AFTER INSERT ON projection_thread_activities BEGIN
      UPDATE projection_threads
      SET last_activity_at = MAX(COALESCE(last_activity_at, ''), NEW.created_at)
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_thread_activities_sidebar_rollup_update
    AFTER UPDATE ON projection_thread_activities BEGIN
      UPDATE projection_threads
      SET last_activity_at = MAX(COALESCE(last_activity_at, ''), NEW.created_at)
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_turns_sidebar_rollup_insert
    AFTER INSERT ON projection_turns BEGIN
      UPDATE projection_threads SET work_status = CASE
        WHEN pending_approval_count > 0 OR pending_user_input_count > 0 THEN 'attention'
        WHEN NEW.state IN ('pending', 'running') THEN 'running'
        WHEN last_activity_at IS NOT NULL
          AND (last_visited_at IS NULL OR last_visited_at < last_activity_at) THEN 'done'
        ELSE 'idle'
      END
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_turns_sidebar_rollup_update
    AFTER UPDATE ON projection_turns BEGIN
      UPDATE projection_threads SET work_status = CASE
        WHEN pending_approval_count > 0 OR pending_user_input_count > 0 THEN 'attention'
        WHEN NEW.state IN ('pending', 'running') THEN 'running'
        WHEN last_activity_at IS NOT NULL
          AND (last_visited_at IS NULL OR last_visited_at < last_activity_at) THEN 'done'
        ELSE 'idle'
      END
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_threads_sidebar_rollup_update
    AFTER UPDATE OF pending_approval_count, pending_user_input_count, last_visited_at, last_activity_at
    ON projection_threads BEGIN
      UPDATE projection_threads SET work_status = ${recomputeStatusSql}
      WHERE thread_id = NEW.thread_id;
    END
  `);
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_sidebar_status_activity
    ON projection_threads(deleted_at, archived_at, work_status, last_activity_at DESC, thread_id)
  `;
});

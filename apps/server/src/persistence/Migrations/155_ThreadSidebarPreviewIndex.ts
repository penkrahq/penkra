import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Match the exact ordering used by the sidebar-preview rollup triggers.
 *
 * The older hot-read index orders nullable sequences with a CASE expression,
 * while these triggers use COALESCE(sequence, -1). SQLite cannot use one
 * expression index to satisfy the other expression, so every streaming message
 * update otherwise sorts the thread's complete message history again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_sidebar_preview
    ON projection_thread_messages(
      thread_id,
      COALESCE(sequence, -1) DESC,
      created_at DESC,
      message_id DESC
    )
  `;
});

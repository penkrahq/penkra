import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Restart reconciliation must find the exceptional rows without scanning the
 * complete message and interaction histories on every server start.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_streaming_assistant
    ON projection_thread_messages(thread_id, message_id)
    WHERE role = 'assistant' AND is_streaming = 1
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_interactions_unresolved
    ON projection_pending_interactions(thread_id, request_id)
    WHERE status <> 'confirmed'
  `;
});

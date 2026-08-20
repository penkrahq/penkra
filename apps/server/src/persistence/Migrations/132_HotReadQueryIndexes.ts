import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Cover the bounded Thread reads that run on every snapshot and resume. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_canonical_order
    ON projection_thread_messages(
      thread_id,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END),
      sequence,
      created_at,
      message_id
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_latest_user
    ON projection_thread_messages(
      thread_id,
      role,
      (CASE WHEN sequence IS NULL THEN 0 ELSE 1 END) DESC,
      sequence DESC,
      created_at DESC,
      message_id DESC
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind_created
    ON projection_thread_activities(thread_id, kind, created_at DESC, activity_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_turn_kind_created
    ON projection_thread_activities(thread_id, turn_id, kind, created_at, activity_id)
  `;
});

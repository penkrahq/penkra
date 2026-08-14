import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS restart_turn_recoveries (
      thread_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Preserve turns that were live when this schema was first installed. Later
  // writes are maintained by the thread-session projection.
  yield* sql`
    INSERT INTO restart_turn_recoveries (thread_id, turn_id, requested_at, updated_at)
    SELECT sessions.thread_id, sessions.active_turn_id,
      COALESCE(turns.requested_at, sessions.updated_at), sessions.updated_at
    FROM projection_thread_sessions AS sessions
    LEFT JOIN projection_turns AS turns
      ON turns.thread_id = sessions.thread_id
     AND turns.turn_id = sessions.active_turn_id
    WHERE sessions.status = 'running' AND sessions.active_turn_id IS NOT NULL
    ON CONFLICT(thread_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      requested_at = excluded.requested_at,
      updated_at = excluded.updated_at
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 116 can only arm turns observed by a server that already has the
  // restart-recovery projector. On the first upgrade restart, the old server
  // has already settled its live turns to `stopped`, so seed those interrupted
  // latest turns from durable history. Explicit Stop/interrupt requests remain
  // authoritative and exclude the turn from automatic continuation.
  yield* sql`
    INSERT INTO restart_turn_recoveries (thread_id, turn_id, requested_at, updated_at)
    SELECT sessions.thread_id, turns.turn_id, turns.requested_at, sessions.updated_at
    FROM projection_thread_sessions AS sessions
    JOIN projection_turns AS turns
      ON turns.thread_id = sessions.thread_id
     AND turns.rowid = (
       SELECT latest.rowid
       FROM projection_turns AS latest
       WHERE latest.thread_id = sessions.thread_id
         AND latest.turn_id IS NOT NULL
       ORDER BY latest.requested_at DESC, latest.rowid DESC
       LIMIT 1
     )
    WHERE sessions.status = 'stopped'
      AND turns.state = 'interrupted'
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS event
        WHERE event.stream_id = sessions.thread_id
          AND event.occurred_at >= turns.requested_at
          AND event.event_type IN (
            'thread.turn-interrupt-requested',
            'thread.session-stop-requested'
          )
      )
    ON CONFLICT(thread_id) DO NOTHING
  `;
});

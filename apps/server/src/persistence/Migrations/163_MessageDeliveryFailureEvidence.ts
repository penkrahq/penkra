import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN delivery_failure_phase TEXT
  `;
  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN delivery_failure_detail TEXT
  `;

  // Restore the exact failure evidence for rows whose current delivery state
  // still points at the authoritative delivery event. A later transition must
  // never inherit stale failure metadata from an earlier attempt.
  yield* sql`
    UPDATE projection_thread_messages AS messages
    SET
      delivery_failure_phase = json_extract(events.payload_json, '$.failurePhase'),
      delivery_failure_detail = json_extract(events.payload_json, '$.failureDetail')
    FROM orchestration_events AS events
    WHERE events.sequence = messages.delivery_sequence
      AND events.event_type = 'thread.message-delivery-set'
      AND json_extract(events.payload_json, '$.threadId') = messages.thread_id
      AND json_extract(events.payload_json, '$.messageId') = messages.message_id
      AND json_extract(events.payload_json, '$.failurePhase') = 'before-provider-dispatch'
  `;
});

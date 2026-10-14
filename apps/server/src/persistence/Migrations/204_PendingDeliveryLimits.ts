// Purpose: Verify old pending work satisfies the admission invariant before bounded delivery starts.
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { QueuedMessage203, SendPayload204, validatePending204 } from "./userItemShapes203.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_thread_items_latest_compaction ON thread_items(thread_id,seq DESC)
    WHERE kind='notice' AND json_valid(data) AND json_extract(data,'$.kind')='context-compaction'`;
  let payloads = 0;
  let queued = 0;
  let afterThread = "";
  let afterSeq = 0;
  while (true) {
    const rows = yield* sql<{ threadId: string; seq: number; payload: string }>`
      SELECT thread_id AS "threadId",seq,send_payload AS payload FROM thread_items
      WHERE kind='user' AND send_payload IS NOT NULL AND (thread_id,seq)>(${afterThread},${afterSeq})
      ORDER BY thread_id,seq LIMIT 50`;
    for (const row of rows) {
      const original = JSON.parse(row.payload);
      const stored = JSON.stringify({ ...original, deliveryRequestId: original.deliveryMessageId });
      const payload = Schema.decodeUnknownSync(SendPayload204)(JSON.parse(stored));
      validatePending204(payload);
      yield* sql`UPDATE thread_items SET send_payload=${stored} WHERE thread_id=${row.threadId} AND seq=${row.seq}`;
      payloads++;
    }
    if (rows.length < 50) break;
    afterThread = rows[rows.length - 1]!.threadId;
    afterSeq = rows[rows.length - 1]!.seq;
  }
  let afterId = "";
  while (true) {
    const rows = yield* sql<{
      id: string;
      queue: string;
    }>`SELECT id,queue FROM threads WHERE id>${afterId} ORDER BY id LIMIT 50`;
    for (const row of rows) {
      const messages = Schema.decodeUnknownSync(Schema.Array(QueuedMessage203))(
        JSON.parse(row.queue),
      );
      for (const message of messages) {
        validatePending204({ message, skills: message.skills, mentions: message.mentions });
        queued++;
      }
    }
    if (rows.length < 50) break;
    afterId = rows[rows.length - 1]!.id;
  }
  yield* Effect.logInfo("Verified pending deliveries against per-turn admission limits", {
    payloads,
    queued,
  });
});

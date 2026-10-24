// Purpose: Make every retained user item, queued input and delivery payload share one origin shape.
import { QueuedMessage203, UserItemData203 } from "./userItemShapes203.ts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const counts = {
    user: 0,
    agent: 0,
    unknownHistoricalAgent: 0,
    steered: 0,
    items: 0,
    payloads: 0,
    queues: 0,
  };
  const record = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Canonical user-item migration encountered a non-object record.");
    return value as Record<string, unknown>;
  };
  const origin = (data: Record<string, unknown>, historical = false) => {
    const sender = data.senderThreadId;
    if (data.dispatchOrigin === "agent" || (typeof sender === "string" && sender.length > 0)) {
      if (typeof sender !== "string" || sender.trim().length === 0) {
        if (historical) {
          counts.agent++;
          counts.unknownHistoricalAgent++;
          return { _tag: "agent" };
        }
        throw new Error("Canonical user-item migration encountered an agent without a sender.");
      }
      counts.agent++;
      return { _tag: "agent", senderThreadId: sender };
    }
    counts.user++;
    return { _tag: "user" };
  };
  const metadata = (value: unknown, historical: boolean) => {
    const data = record(value);
    if (data.truncated === true)
      throw new Error("Canonical user-item migration cannot reconstruct truncated user metadata.");
    const steered = data.dispatchMode === "steer";
    if (steered) counts.steered++;
    return Schema.decodeUnknownSync(UserItemData203)({
      origin: origin(data, historical),
      attachments: data.attachments ?? [],
      ...(data.skills == null ? {} : { skills: data.skills }),
      ...(data.mentions == null ? {} : { mentions: data.mentions }),
      ...(steered ? { steered: true } : {}),
    });
  };
  const message = (value: unknown) => {
    const data = record(value);
    const { senderThreadId: _sender, dispatchOrigin: _dispatch, ...rest } = data;
    return Schema.encodeSync(QueuedMessage203)(
      Schema.decodeUnknownSync(QueuedMessage203)({ ...rest, origin: origin(data) }),
    );
  };
  yield* sql.withTransaction(
    Effect.gen(function* () {
      let after = 0;
      let afterThreadId = "";
      while (true) {
        const rows = yield* sql<{
          threadId: string;
          seq: number;
          data: string | null;
          payload: string | null;
        }>`
        SELECT thread_id AS "threadId",seq,data,send_payload AS payload FROM thread_items
        WHERE kind='user' AND (thread_id,seq)>(${afterThreadId},${after}) ORDER BY thread_id,seq LIMIT 50`;
        for (const row of rows) {
          const data = Schema.encodeSync(UserItemData203)(
            metadata(
              row.data === null ? {} : JSON.parse(row.data),
              // Historical rows have no operational payload; actual queue entries
              // and retryable payloads are decoded separately with a required sender.
              row.payload === null,
            ),
          );
          let payload: string | null = null;
          if (row.payload !== null) {
            const stored = record(JSON.parse(row.payload));
            payload = JSON.stringify({ ...stored, message: message(stored.message) });
            counts.payloads++;
          }
          yield* sql`UPDATE thread_items SET data=${JSON.stringify(data)},send_payload=${payload} WHERE thread_id=${row.threadId} AND seq=${row.seq}`;
          counts.items++;
        }
        if (rows.length < 50) break;
        after = rows[rows.length - 1]!.seq;
        afterThreadId = rows[rows.length - 1]!.threadId;
      }
      let afterId = "";
      while (true) {
        const rows = yield* sql<{
          id: string;
          queue: string;
        }>`SELECT id,queue FROM threads WHERE id>${afterId} ORDER BY id LIMIT 50`;
        for (const row of rows) {
          const queue: unknown = JSON.parse(row.queue);
          if (!Array.isArray(queue))
            throw new Error("Canonical user-item migration encountered a non-array queue.");
          if (!queue.length) continue;
          const rewritten = queue.map(message);
          yield* sql`UPDATE threads SET queue=${JSON.stringify(rewritten)} WHERE id=${row.id}`;
          counts.queues += rewritten.length;
        }
        if (rows.length < 50) break;
        afterId = rows[rows.length - 1]!.id;
      }
    }),
  );
  yield* Effect.logInfo("Canonical user-message format migrated", counts);
});

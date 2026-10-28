import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A single indexed lookup plus the thread's bounded queue, for resolving an
 * interrupted send before retrying its original durable message ID. */
export const getMessageAdmission = (input: { threadId: string; messageId: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ present: number }>`SELECT (EXISTS(
    SELECT 1 FROM thread_items WHERE thread_id=${input.threadId} AND source_id=${input.messageId} AND kind='user'
  ) OR EXISTS(SELECT 1 FROM json_each(t.queue) WHERE json_extract(value,'$.messageId')=${input.messageId})) AS present
    FROM threads t WHERE t.id=${input.threadId} AND t.deleted_at IS NULL`;
    return { threadExists: !!row, present: !!row?.present };
  });

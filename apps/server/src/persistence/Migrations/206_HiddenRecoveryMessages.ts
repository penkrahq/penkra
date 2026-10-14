// Retag only the exact Play prompt; ordinary operator text remains visible.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const prompt =
    "The previous turn did not finish. Continue the existing task from the current state. Verify the current state before repeating any action whose outcome may be uncertain.";
  const affected = yield* sql<{ thread_id: string }>`SELECT DISTINCT thread_id FROM thread_items
    WHERE kind='user' AND text=${prompt} AND json_extract(data,'$.origin._tag')='user'`;
  yield* sql`UPDATE thread_items SET data=json_set(data,'$.origin',json('{"_tag":"recovery"}'))
    WHERE kind='user' AND text=${prompt} AND json_extract(data,'$.origin._tag')='user'`;
  for (const row of affected) {
    yield* sql`UPDATE threads SET
      last_message_preview=(SELECT text FROM thread_items WHERE thread_id=${row.thread_id}
        AND kind IN ('user','text') AND (kind<>'user' OR json_extract(data,'$.origin._tag')<>'recovery') ORDER BY seq DESC LIMIT 1),
      last_user_message_at=(SELECT created_at FROM thread_items WHERE thread_id=${row.thread_id}
        AND kind='user' AND json_extract(data,'$.origin._tag')<>'recovery' ORDER BY seq DESC LIMIT 1)
      WHERE id=${row.thread_id}`;
  }
});

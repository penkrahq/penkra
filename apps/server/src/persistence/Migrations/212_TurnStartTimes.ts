import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* sql`UPDATE thread_items AS marker SET data=json_set(COALESCE(data,'{}'),
    '$.startedAt',(SELECT MIN(item.created_at) FROM thread_items item
      WHERE item.thread_id=marker.thread_id AND item.turn_id=marker.turn_id),
    '$.endedAt',(SELECT MAX(item.updated_at) FROM thread_items item
      WHERE item.thread_id=marker.thread_id AND item.turn_id=marker.turn_id))
    WHERE kind='turn' AND json_extract(data,'$.startedAt') IS NULL RETURNING source_id`;
  const [invalid] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM thread_items
    WHERE kind='turn' AND json_extract(data,'$.startedAt') IS NULL`;
  if (invalid!.count !== 0)
    return yield* Effect.fail(new Error("A turn marker has no start timestamp after backfill."));
  yield* Effect.logInfo("Backfilled historical turn times from their items", {
    updated: changed.length,
  });
});

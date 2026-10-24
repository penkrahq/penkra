import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reasoning = yield* sql`DELETE FROM thread_items WHERE kind='reasoning' RETURNING source_id`;
  const notices = yield* sql`DELETE FROM thread_items WHERE kind='notice'
    AND source_id GLOB 'rs_*'
    AND thread_id IN (SELECT id FROM threads WHERE provider='codex') RETURNING source_id`;
  yield* Effect.logInfo("Removed provider reasoning transcript rows", {
    reasoningRows: reasoning.length,
    codexReasoningNotices: notices.length,
  });
});

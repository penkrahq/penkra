import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* sql`UPDATE thread_items SET data=json_object(
    'tone','info','kind','provider-stopped','summary',
    (SELECT CASE provider WHEN 'codex' THEN 'ChatGPT' WHEN 'claudeAgent' THEN 'Claude'
      WHEN 'opencode' THEN 'OpenCode' ELSE provider END FROM threads WHERE id=thread_id) || ' stopped before finishing',
    'payload',json('{}'))
    WHERE kind='notice' AND source_id LIKE 'provider-cutoff:%' AND data IS NULL RETURNING source_id`;
  yield* Effect.logInfo("Converted historical provider cut-offs to transcript separators", {
    converted: changed.length,
  });
});

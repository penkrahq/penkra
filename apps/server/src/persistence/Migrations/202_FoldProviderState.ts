// Purpose: Fold provider-native ownership and resume identity into canonical threads.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [before] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM threads`;
  // Historical owner evidence: ThreadProviderBindings.ts:175-184 committed the
  // binding together with the copied native generation; composer picks changed
  // projection_threads.connection_id independently. New canonical copies already
  // have a different native id and retain their committed account/state pair.
  const [mismatch] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM threads t
 JOIN thread_runtime_bindings b ON b.thread_id=t.id
 LEFT JOIN thread_harness_states h ON h.thread_id=t.id
 WHERE (t.native_state_id IS NOT NULL OR t.provider_session_id IS NOT NULL OR h.native_state_generation_id IS NOT NULL)
 AND (t.native_state_id IS NULL OR t.native_state_id=h.native_state_generation_id OR EXISTS (SELECT 1 FROM provider_native_state_generations g WHERE g.owner_thread_id=t.id AND g.native_state_generation_id=t.native_state_id))
 AND t.connection_id IS NOT b.connection_id`;
  yield* sql`WITH folded AS MATERIALIZED (
 SELECT t.id,
  COALESCE(t.native_state_id,h.native_state_generation_id,(SELECT g.native_state_generation_id FROM provider_native_state_generations g WHERE g.owner_thread_id=t.id AND g.lifecycle='active' LIMIT 1)) AS native_id,
  COALESCE(t.provider_session_id,h.provider_session_id,CASE r.provider_name
   WHEN 'codex' THEN json_extract(r.resume_cursor_json,'$.threadId')
   WHEN 'claudeAgent' THEN json_extract(r.resume_cursor_json,'$.resume')
   WHEN 'opencode' THEN CASE WHEN json_type(r.resume_cursor_json)='text' THEN json_extract(r.resume_cursor_json,'$') ELSE json_extract(r.resume_cursor_json,'$.openCodeSessionId') END END) AS session_id,
  CASE WHEN t.native_state_id IS NOT NULL AND t.native_state_id IS NOT h.native_state_generation_id
    AND NOT EXISTS(SELECT 1 FROM provider_native_state_generations g WHERE g.owner_thread_id=t.id AND g.native_state_generation_id=t.native_state_id)
   THEN t.connection_id
   WHEN t.native_state_id IS NOT NULL OR t.provider_session_id IS NOT NULL OR h.native_state_generation_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM provider_native_state_generations g WHERE g.owner_thread_id=t.id AND g.lifecycle='active')
   THEN b.connection_id ELSE t.connection_id END AS owner_connection
 FROM threads t LEFT JOIN thread_harness_states h ON h.thread_id=t.id
 LEFT JOIN thread_runtime_bindings b ON b.thread_id=t.id
 LEFT JOIN provider_session_runtime r ON r.thread_id=t.id
 ) UPDATE threads SET connection_id=(SELECT owner_connection FROM folded WHERE folded.id=threads.id),
 native_state_id=(SELECT native_id FROM folded WHERE folded.id=threads.id),
 provider_session_id=(SELECT session_id FROM folded WHERE folded.id=threads.id)`;
  for (const table of [
    "thread_runtime_bindings",
    "thread_harness_states",
    "provider_session_runtime",
    "provider_native_state_generations",
  ])
    yield* sql`DROP TABLE ${sql.literal('"' + table + '"')}`;
  const [after] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM threads`;
  if (before?.count !== after?.count)
    return yield* Effect.fail(new Error("Folding provider state changed the thread count."));
  const violations = yield* sql`PRAGMA foreign_key_check`;
  if (violations.length)
    return yield* Effect.fail(new Error("Folding provider state left a foreign-key violation."));
  yield* Effect.logInfo("Folded provider state into threads", {
    threads: after!.count,
    ownerConnectionMismatches: mismatch?.count ?? 0,
  });
});

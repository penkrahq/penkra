import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_state WHERE projector IN ('projection.threads', 'projection.thread-shell-summaries')`;
  const definitions = yield* sql<{ type: string; name: string; sql: string }>`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name IN ('thread_harness_states', 'thread_runtime_bindings')
      AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END
  `;
  const missing = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM thread_harness_states AS state
    WHERE NOT EXISTS (SELECT 1 FROM threads WHERE id = state.thread_id)
  `;
  const missingBindings = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM thread_runtime_bindings
    WHERE NOT EXISTS (SELECT 1 FROM threads WHERE id = thread_runtime_bindings.thread_id)`;
  // Back up the dependent rows before dropping the parent: its CASCADE must
  // remain intact, but must not erase bindings for retained threads.
  yield* sql`CREATE TEMP TABLE canonical_harness_rows AS
    SELECT state.* FROM thread_harness_states AS state
    JOIN threads ON threads.id = state.thread_id`;
  yield* sql`CREATE TEMP TABLE canonical_binding_rows AS
    SELECT binding.* FROM thread_runtime_bindings AS binding
    JOIN threads ON threads.id = binding.thread_id`;
  for (const definition of definitions) {
    if (definition.type === "trigger") {
      yield* sql.unsafe(`DROP TRIGGER "${definition.name}"`);
    }
  }
  yield* sql`DROP TABLE thread_runtime_bindings`;
  yield* sql`DROP TABLE thread_harness_states`;
  for (const definition of definitions) {
    if (definition.type === "table") {
      yield* sql.unsafe(
        definition.sql.replace(
          "REFERENCES projection_threads(thread_id)",
          "REFERENCES threads(id)",
        ),
      );
    }
  }
  yield* sql`INSERT INTO thread_harness_states SELECT * FROM canonical_harness_rows`;
  yield* sql`INSERT INTO thread_runtime_bindings SELECT * FROM canonical_binding_rows`;
  for (const definition of definitions) {
    if (definition.type !== "table") yield* sql.unsafe(definition.sql);
  }
  yield* sql`DROP TABLE canonical_binding_rows`;
  yield* sql`DROP TABLE canonical_harness_rows`;
  // Notices remain in use until the transcript cut removes their old table.
  // New threads must be valid parents during that cut as well.
  const noticeDefinitions = yield* sql<{ type: string; sql: string }>`
    SELECT type, sql FROM sqlite_master WHERE tbl_name = 'notices' AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END
  `;
  const missingNotices = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM notices
    WHERE NOT EXISTS (SELECT 1 FROM threads WHERE id = notices.thread_id)`;
  yield* sql`CREATE TEMP TABLE canonical_notice_rows AS SELECT notices.* FROM notices
    JOIN threads ON threads.id = notices.thread_id`;
  yield* sql`DROP TABLE notices`;
  for (const definition of noticeDefinitions) {
    yield* sql.unsafe(
      definition.sql.replace("REFERENCES projection_threads(thread_id)", "REFERENCES threads(id)"),
    );
  }
  yield* sql`INSERT INTO notices SELECT * FROM canonical_notice_rows`;
  yield* sql`DROP TABLE canonical_notice_rows`;
  yield* Effect.logInfo("Redirected thread harness foreign key", {
    droppedHarnessRows: missing[0]!.count,
    droppedBindingRows: missingBindings[0]!.count,
    droppedNoticeRows: missingNotices[0]!.count,
  });
});

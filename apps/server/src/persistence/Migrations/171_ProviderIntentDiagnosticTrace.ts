import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The intent keeps its trace even after diagnostic detail retention expires.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existing = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(provider_intent_outbox)`).map(
      (column) => column.name,
    ),
  );
  for (const column of [
    "diagnostic_trace_id",
    "diagnostic_span_id",
    "diagnostic_parent_span_id",
    "diagnostic_attempt_id",
  ] as const) {
    if (!existing.has(column)) {
      yield* sql.unsafe(`ALTER TABLE provider_intent_outbox ADD COLUMN ${column} TEXT`);
    }
  }
});

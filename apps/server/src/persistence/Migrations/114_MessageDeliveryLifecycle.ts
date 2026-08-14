import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface ColumnRow {
  readonly name: string;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<ColumnRow>`PRAGMA table_info(projection_thread_messages)`;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("delivery_state")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN delivery_state TEXT`;
  }
  if (!names.has("delivery_queued")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN delivery_queued INTEGER`;
  }
  if (!names.has("delivery_sequence")) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN delivery_sequence INTEGER`;
  }
});

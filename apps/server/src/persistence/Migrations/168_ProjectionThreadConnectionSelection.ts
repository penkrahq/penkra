import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [column] = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1 FROM pragma_table_info('projection_threads') WHERE name = 'connection_id'
    ) AS "exists"
  `;
  if (column?.exists !== 1) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN connection_id TEXT`;
  }
  const [selectionColumn] = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1 FROM pragma_table_info('projection_threads') WHERE name = 'connection_id_selected'
    ) AS "exists"
  `;
  if (selectionColumn?.exists === 1) return;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN connection_id_selected INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    UPDATE projection_threads
    SET connection_id = (
      SELECT binding.connection_id FROM thread_runtime_bindings AS binding
      WHERE binding.thread_id = projection_threads.thread_id
    ),
    connection_id_selected = 1
    WHERE EXISTS (
      SELECT 1 FROM thread_runtime_bindings AS binding
      WHERE binding.thread_id = projection_threads.thread_id
    )
  `;
});

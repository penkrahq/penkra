import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Makes the provider operation identity queryable without repeatedly parsing
 * activity payload JSON. Historical rows are backfilled only when the payload
 * carries an explicit non-empty operationId; ambiguous rows remain unchanged.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_activities')
  `;
  if (!columns.some(({ name }) => name === "operation_id")) {
    yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN operation_id TEXT`;
  }

  yield* sql`
    UPDATE projection_thread_activities
    SET operation_id = json_extract(payload_json, '$.operationId')
    WHERE operation_id IS NULL
      AND json_type(payload_json, '$.operationId') = 'text'
      AND trim(json_extract(payload_json, '$.operationId')) <> ''
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_operation
    ON projection_thread_activities(thread_id, operation_id)
    WHERE operation_id IS NOT NULL
  `;
});

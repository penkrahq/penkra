import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// `activity_json` is the canonical payload consumed by thread_activities_read.
// `detail_json` held the same latest provider envelope and had no reader.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('operations')
  `;
  if (columns.some(({ name }) => name === "detail_json")) {
    yield* sql`ALTER TABLE operations DROP COLUMN detail_json`;
  }
});

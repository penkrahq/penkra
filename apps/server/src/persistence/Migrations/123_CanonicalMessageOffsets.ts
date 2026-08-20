// Persist the exact UTF-8 extent of each canonical message. SQLite length(text)
// counts code points, so the BLOB cast is required for the byte-addressed CAS
// used by provider fragment ingestion.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_messages')
  `;
  if (!columns.some(({ name }) => name === "applied_len")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN applied_len INTEGER NOT NULL DEFAULT 0 CHECK (applied_len >= 0)
    `;
  }
  yield* sql`
    UPDATE projection_thread_messages
    SET applied_len = length(CAST(text AS BLOB))
    WHERE applied_len <> length(CAST(text AS BLOB))
  `;
});

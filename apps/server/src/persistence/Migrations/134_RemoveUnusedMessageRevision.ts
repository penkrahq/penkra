// Purpose: Remove a message-only deletion watermark superseded by full thread-detail snapshots.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 128 briefly introduced this writer without a reader. Thread detail is
  // transported as an authoritative, sequence-fenced full snapshot, so retaining a
  // message-only watermark would both be dead schema and falsely imply that activity
  // or turn deletions were safe for a row-delta consumer.
  yield* sql`DROP TRIGGER IF EXISTS projection_thread_messages_revision_delete`;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  if (columns.some(({ name }) => name === "messages_revision")) {
    yield* sql`ALTER TABLE projection_threads DROP COLUMN messages_revision`;
  }
});

// FILE: 182_RemoveParentThreads.ts
// Purpose: Preserve former child chats as ordinary threads and remove their parent relationship.
// Layer: SQLite migration

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const affected = yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM threads WHERE parent_thread_id IS NOT NULL`;
  yield* sql`ALTER TABLE threads DROP COLUMN parent_thread_id`;
  yield* Effect.logInfo("Removed parent relationships; all chats retained", {
    affectedThreads: affected[0]!.count,
  });
});

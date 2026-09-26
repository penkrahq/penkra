import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_thread_messages", "sender_thread_id"))) {
    yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN sender_thread_id TEXT`;
  }
});

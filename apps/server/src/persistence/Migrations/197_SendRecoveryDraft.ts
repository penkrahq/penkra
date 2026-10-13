import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_items ADD COLUMN recovery_draft TEXT`;
  yield* sql`ALTER TABLE thread_items ADD COLUMN admission_plan TEXT CHECK (admission_plan IN ('deliver','steer','interrupt-deliver'))`;
  yield* sql`CREATE INDEX idx_thread_items_sending ON thread_items(thread_id,seq) WHERE kind='user' AND status='sending'`;
});

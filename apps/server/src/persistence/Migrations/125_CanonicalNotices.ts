import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS notices (
      notice_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      tone TEXT NOT NULL CHECK (tone IN ('info', 'warning', 'error')),
      summary TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_notices_thread_created
    ON notices(thread_id, created_at, notice_id)
  `;
});

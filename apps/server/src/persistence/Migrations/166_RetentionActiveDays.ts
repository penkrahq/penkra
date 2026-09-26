import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS retention_active_days (
      day_utc TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL
    )
  `;
});

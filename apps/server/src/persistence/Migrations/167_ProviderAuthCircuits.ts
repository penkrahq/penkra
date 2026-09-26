import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_auth_circuits (
      connection_id TEXT PRIMARY KEY REFERENCES provider_connections(connection_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('provider-rejected', 'reauth-required')),
      summary TEXT NOT NULL,
      detail TEXT NOT NULL,
      profile_ref TEXT,
      opened_at TEXT NOT NULL,
      next_probe_at TEXT NOT NULL,
      failure_count INTEGER NOT NULL CHECK (failure_count > 0)
    )
  `;
});

import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE remote_devices (
      device_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      identity_key BLOB NOT NULL CHECK (length(identity_key) = 32),
      session_id TEXT NOT NULL UNIQUE REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
      paired_at TEXT NOT NULL,
      last_connected_at TEXT,
      pending_backend INTEGER NOT NULL CHECK (pending_backend IN (0, 1))
    ) STRICT
  `;
});

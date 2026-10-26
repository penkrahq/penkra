import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // RemoteLink has not been mounted in the desktop lifecycle. Never guess an
  // account owner or discard trust if an unexpected writer populated its table.
  const rows = yield* sql<{ count: number }>`SELECT count(*) AS count FROM remote_devices`;
  if (rows[0]?.count !== 0)
    return yield* Effect.fail(new Error("Cannot assign an account to unscoped RemoteLink trust."));
  yield* sql`DROP TABLE remote_devices`;
  yield* sql`
    CREATE TABLE remote_devices (
      scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
      device_id TEXT NOT NULL,
      name TEXT NOT NULL,
      identity_key BLOB NOT NULL CHECK (length(identity_key) = 32),
      session_id TEXT NOT NULL UNIQUE REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
      paired_at TEXT NOT NULL,
      last_connected_at TEXT,
      pending_backend INTEGER NOT NULL CHECK (pending_backend IN (0, 1)),
      PRIMARY KEY (scope_key, device_id)
    ) STRICT
  `;
});

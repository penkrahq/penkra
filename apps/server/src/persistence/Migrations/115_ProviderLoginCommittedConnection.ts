// FILE: 115_ProviderLoginCommittedConnection.ts
// Purpose: Separates an isolated login attempt from the durable Connection it reactivates.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "provider_connection_logins", "committed_connection_id"))) {
    yield* sql.unsafe(`
      ALTER TABLE provider_connection_logins
      ADD COLUMN committed_connection_id TEXT
        REFERENCES provider_connections(connection_id) ON DELETE RESTRICT
    `);
  }
});

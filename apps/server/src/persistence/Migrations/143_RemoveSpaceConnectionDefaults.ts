import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TRIGGER IF EXISTS provider_connections_default_unconfigured_spaces`;
  yield* sql`DROP TRIGGER IF EXISTS projection_spaces_default_active_connections`;
  yield* sql`DROP TRIGGER IF EXISTS provider_connections_replace_terminated_space_default`;
  yield* sql`DROP TRIGGER IF EXISTS space_connection_defaults_compatible_insert`;
  yield* sql`DROP TRIGGER IF EXISTS space_connection_defaults_compatible_update`;
  yield* sql`DROP TABLE IF EXISTS space_connection_defaults`;
});

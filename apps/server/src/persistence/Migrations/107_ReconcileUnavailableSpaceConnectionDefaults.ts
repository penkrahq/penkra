// FILE: 107_ReconcileUnavailableSpaceConnectionDefaults.ts
// Purpose: Keep Space defaults absent or bound to the newest active Connection.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TRIGGER IF EXISTS provider_connections_replace_terminated_space_default`;

  yield* sql.unsafe(`
    UPDATE space_connection_defaults
    SET connection_id = (
      SELECT candidate.connection_id
      FROM provider_connections AS current
      JOIN provider_connections AS candidate
        ON candidate.harness_kind = current.harness_kind
       AND candidate.lifecycle = 'active'
      WHERE current.connection_id = space_connection_defaults.connection_id
      ORDER BY candidate.created_at DESC, candidate.connection_id DESC
      LIMIT 1
    ),
    updated_at = (
      SELECT candidate.updated_at
      FROM provider_connections AS current
      JOIN provider_connections AS candidate
        ON candidate.harness_kind = current.harness_kind
       AND candidate.lifecycle = 'active'
      WHERE current.connection_id = space_connection_defaults.connection_id
      ORDER BY candidate.created_at DESC, candidate.connection_id DESC
      LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1
      FROM provider_connections AS current
      JOIN provider_connections AS candidate
        ON candidate.harness_kind = current.harness_kind
       AND candidate.lifecycle = 'active'
      WHERE current.connection_id = space_connection_defaults.connection_id
        AND current.lifecycle = 'terminated'
    )
  `);

  yield* sql.unsafe(`
    DELETE FROM space_connection_defaults
    WHERE EXISTS (
      SELECT 1 FROM provider_connections AS current
      WHERE current.connection_id = space_connection_defaults.connection_id
        AND current.lifecycle = 'terminated'
    )
  `);

  yield* sql.unsafe(`
    CREATE TRIGGER provider_connections_replace_terminated_space_default
    AFTER UPDATE OF lifecycle ON provider_connections
    WHEN OLD.lifecycle = 'active' AND NEW.lifecycle = 'terminated'
    BEGIN
      UPDATE space_connection_defaults
      SET connection_id = (
        SELECT candidate.connection_id
        FROM provider_connections AS candidate
        WHERE candidate.harness_kind = OLD.harness_kind
          AND candidate.lifecycle = 'active'
        ORDER BY candidate.created_at DESC, candidate.connection_id DESC
        LIMIT 1
      ),
      updated_at = NEW.updated_at
      WHERE connection_id = OLD.connection_id
        AND EXISTS (
          SELECT 1 FROM provider_connections AS candidate
          WHERE candidate.harness_kind = OLD.harness_kind
            AND candidate.lifecycle = 'active'
        );

      DELETE FROM space_connection_defaults
      WHERE connection_id = OLD.connection_id;
    END
  `);
});

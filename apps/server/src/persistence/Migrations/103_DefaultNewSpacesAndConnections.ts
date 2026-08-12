// FILE: 103_DefaultNewSpacesAndConnections.ts
// Purpose: Persist deterministic Space defaults whenever either side is created.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    INSERT INTO space_connection_defaults (
      space_id, harness_kind, connection_id, created_at, updated_at
    )
    SELECT
      space.space_id,
      connection.harness_kind,
      connection.connection_id,
      connection.created_at,
      connection.updated_at
    FROM projection_spaces AS space
    JOIN provider_connections AS connection
      ON connection.lifecycle = 'active'
     AND connection.connection_id = (
       SELECT candidate.connection_id
       FROM provider_connections AS candidate
       WHERE candidate.harness_kind = connection.harness_kind
         AND candidate.lifecycle = 'active'
       ORDER BY candidate.created_at DESC, candidate.connection_id DESC
       LIMIT 1
     )
    WHERE space.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM space_connection_defaults AS existing
        WHERE existing.space_id = space.space_id
          AND existing.harness_kind = connection.harness_kind
      )
  `);

  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_connections_default_unconfigured_spaces
    AFTER INSERT ON provider_connections
    WHEN NEW.lifecycle = 'active'
    BEGIN
      INSERT INTO space_connection_defaults (
        space_id, harness_kind, connection_id, created_at, updated_at
      )
      SELECT space.space_id, NEW.harness_kind, NEW.connection_id, NEW.created_at, NEW.updated_at
      FROM projection_spaces AS space
      WHERE space.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM space_connection_defaults AS existing
          WHERE existing.space_id = space.space_id
            AND existing.harness_kind = NEW.harness_kind
        );
    END
  `);

  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_spaces_default_active_connections
    AFTER INSERT ON projection_spaces
    WHEN NEW.deleted_at IS NULL
    BEGIN
      INSERT INTO space_connection_defaults (
        space_id, harness_kind, connection_id, created_at, updated_at
      )
      SELECT
        NEW.space_id,
        connection.harness_kind,
        connection.connection_id,
        connection.created_at,
        connection.updated_at
      FROM provider_connections AS connection
      WHERE connection.lifecycle = 'active'
        AND connection.connection_id = (
          SELECT candidate.connection_id
          FROM provider_connections AS candidate
          WHERE candidate.harness_kind = connection.harness_kind
            AND candidate.lifecycle = 'active'
          ORDER BY candidate.created_at DESC, candidate.connection_id DESC
          LIMIT 1
        );
    END
  `);
});

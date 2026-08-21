// FILE: 146_ProviderRuntimeInstallationMigration.ts
// Purpose: Allow a revision-checked thread binding to move to the active managed runtime.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`DROP TRIGGER IF EXISTS thread_runtime_bindings_compatible_update`);
  yield* sql.unsafe(`
    CREATE TRIGGER thread_runtime_bindings_compatible_update
    BEFORE UPDATE ON thread_runtime_bindings
    BEGIN
      SELECT CASE WHEN NEW.thread_id != OLD.thread_id
        THEN RAISE(ABORT, 'thread binding identity is immutable') END;
      SELECT CASE WHEN NEW.binding_revision != OLD.binding_revision + 1
        THEN RAISE(ABORT, 'thread binding revision must increment exactly once') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM thread_harness_states AS state
        JOIN provider_installations AS installation
          ON installation.installation_id = NEW.installation_id
        LEFT JOIN provider_connections AS connection
          ON connection.connection_id = NEW.connection_id
        WHERE state.thread_id = NEW.thread_id
          AND installation.harness_kind = state.harness_kind
          AND (
            (
              NEW.installation_id = OLD.installation_id AND
              installation.lifecycle IN ('active', 'retired')
            ) OR (
              NEW.installation_id != OLD.installation_id AND
              installation.lifecycle = 'active'
            )
          )
          AND (
            NEW.connection_id IS NULL OR
            (connection.harness_kind = state.harness_kind AND connection.lifecycle = 'active')
          )
      ) THEN RAISE(ABORT, 'incompatible thread runtime binding') END;
    END
  `);
});

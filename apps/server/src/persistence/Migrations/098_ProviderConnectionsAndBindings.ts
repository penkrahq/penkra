// FILE: 098_ProviderConnectionsAndBindings.ts
// Purpose: Adds the clean-cut durable model for managed installations, Connections, native state, and bindings.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const HARNESS_CHECK = "length(trim(harness_kind)) > 0";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_installations (
      installation_id TEXT PRIMARY KEY,
      harness_kind TEXT NOT NULL CHECK (${HARNESS_CHECK}),
      version TEXT NOT NULL,
      platform TEXT NOT NULL,
      architecture TEXT NOT NULL,
      executable_path TEXT NOT NULL UNIQUE,
      artifact_source TEXT NOT NULL,
      artifact_url TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
      adapter_version TEXT NOT NULL,
      protocol_version TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('staged', 'active', 'retired', 'rejected')),
      health_reason TEXT,
      installed_at TEXT NOT NULL,
      activated_at TEXT,
      retired_at TEXT
    )
  `);
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_installations_one_active_harness
    ON provider_installations(harness_kind)
    WHERE lifecycle = 'active'
  `;
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_installations_reject_identity_collision
    BEFORE INSERT ON provider_installations
    WHEN EXISTS (
      SELECT 1 FROM provider_installations AS existing
      WHERE existing.installation_id = NEW.installation_id
        AND (
          existing.harness_kind != NEW.harness_kind OR
          existing.version != NEW.version OR
          existing.platform != NEW.platform OR
          existing.architecture != NEW.architecture OR
          existing.executable_path != NEW.executable_path OR
          existing.artifact_source != NEW.artifact_source OR
          existing.artifact_url != NEW.artifact_url OR
          existing.artifact_sha256 != NEW.artifact_sha256 OR
          existing.adapter_version != NEW.adapter_version OR
          existing.protocol_version != NEW.protocol_version OR
          existing.installed_at != NEW.installed_at
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'provider installation identity collision');
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_installations_immutable_update
    BEFORE UPDATE ON provider_installations
    WHEN
      OLD.installation_id != NEW.installation_id OR
      OLD.harness_kind != NEW.harness_kind OR
      OLD.version != NEW.version OR
      OLD.platform != NEW.platform OR
      OLD.architecture != NEW.architecture OR
      OLD.executable_path != NEW.executable_path OR
      OLD.artifact_source != NEW.artifact_source OR
      OLD.artifact_url != NEW.artifact_url OR
      OLD.artifact_sha256 != NEW.artifact_sha256 OR
      OLD.adapter_version != NEW.adapter_version OR
      OLD.protocol_version != NEW.protocol_version OR
      OLD.installed_at != NEW.installed_at
    BEGIN
      SELECT RAISE(ABORT, 'provider installation generation is immutable');
    END
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      connection_id TEXT PRIMARY KEY,
      harness_kind TEXT NOT NULL CHECK (${HARNESS_CHECK}),
      authentication_target_id TEXT NOT NULL,
      authentication_method_id TEXT NOT NULL,
      label TEXT NOT NULL CHECK (length(trim(label)) > 0),
      credential_ref TEXT,
      profile_ref TEXT,
      provider_identity_id TEXT,
      health_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('unknown', 'ready', 'unavailable')),
      health_reason TEXT,
      last_checked_at TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'active'
        CHECK (lifecycle IN ('active', 'terminated')),
      termination_reason TEXT
        CHECK (termination_reason IS NULL OR termination_reason IN (
          'signed-out', 'disconnected', 'removed', 'credential-rejected', 'expired'
        )),
      terminated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (lifecycle = 'active' AND termination_reason IS NULL AND terminated_at IS NULL) OR
        (lifecycle = 'terminated' AND termination_reason IS NOT NULL AND terminated_at IS NOT NULL)
      ),
      CHECK (credential_ref IS NOT NULL OR profile_ref IS NOT NULL)
    )
  `);
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_active_label
    ON provider_connections(harness_kind, lower(label))
    WHERE lifecycle = 'active'
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_active_identity
    ON provider_connections(harness_kind, authentication_target_id, provider_identity_id)
    WHERE lifecycle = 'active' AND provider_identity_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_credential_ref
    ON provider_connections(credential_ref)
    WHERE credential_ref IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_profile_ref
    ON provider_connections(profile_ref)
    WHERE profile_ref IS NOT NULL
  `;

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_connection_operations (
      operation_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create-static', 'terminate')),
      operation_state TEXT NOT NULL CHECK (operation_state IN (
        'pending', 'credential-stored', 'credential-removed', 'completed', 'failed'
      )),
      credential_ref TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (operation_state = 'failed' AND failure_reason IS NOT NULL) OR
        (operation_state != 'failed' AND failure_reason IS NULL)
      )
    )
  `);
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connection_operations_one_open_per_connection
    ON provider_connection_operations(connection_id)
    WHERE operation_state NOT IN ('completed', 'failed')
  `;
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_connection_operations_valid_transition
    BEFORE UPDATE ON provider_connection_operations
    BEGIN
      SELECT CASE WHEN
        NEW.operation_id != OLD.operation_id OR
        NEW.connection_id != OLD.connection_id OR
        NEW.operation_kind != OLD.operation_kind OR
        NEW.payload_json != OLD.payload_json OR
        NEW.created_at != OLD.created_at
      THEN RAISE(ABORT, 'provider connection operation identity is immutable') END;
      SELECT CASE WHEN NOT (
        (OLD.operation_state = 'pending' AND NEW.operation_state IN (
          'credential-stored', 'credential-removed', 'failed'
        )) OR
        (OLD.operation_state = 'credential-stored' AND NEW.operation_state IN ('completed', 'failed')) OR
        (OLD.operation_state = 'credential-removed' AND NEW.operation_state IN ('completed', 'failed'))
      ) THEN RAISE(ABORT, 'invalid provider connection operation transition') END;
    END
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_native_state_generations (
      native_state_generation_id TEXT PRIMARY KEY,
      harness_kind TEXT NOT NULL CHECK (${HARNESS_CHECK}),
      adapter_schema_version TEXT NOT NULL,
      state_manifest_json TEXT NOT NULL CHECK (json_valid(state_manifest_json)),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retained', 'garbage-eligible')),
      created_at TEXT NOT NULL,
      retained_at TEXT,
      garbage_eligible_at TEXT
    )
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS thread_harness_states (
      thread_id TEXT PRIMARY KEY,
      harness_kind TEXT NOT NULL CHECK (${HARNESS_CHECK}),
      native_state_generation_id TEXT NOT NULL,
      provider_session_id TEXT,
      native_state_locator_json TEXT NOT NULL CHECK (json_valid(native_state_locator_json)),
      last_verified_resume_at TEXT,
      state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      FOREIGN KEY (native_state_generation_id)
        REFERENCES provider_native_state_generations(native_state_generation_id) ON DELETE RESTRICT
    )
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS thread_harness_states_compatible_insert
    BEFORE INSERT ON thread_harness_states
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_native_state_generations AS generation
        WHERE generation.native_state_generation_id = NEW.native_state_generation_id
          AND generation.harness_kind = NEW.harness_kind
          AND generation.lifecycle = 'active'
      ) THEN RAISE(ABORT, 'incompatible thread native state generation') END;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS thread_harness_states_compatible_update
    BEFORE UPDATE ON thread_harness_states
    BEGIN
      SELECT CASE WHEN NEW.thread_id != OLD.thread_id OR NEW.harness_kind != OLD.harness_kind
        THEN RAISE(ABORT, 'thread harness identity is immutable') END;
      SELECT CASE WHEN NEW.state_revision != OLD.state_revision + 1
        THEN RAISE(ABORT, 'thread native state revision must increment exactly once') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_native_state_generations AS generation
        WHERE generation.native_state_generation_id = NEW.native_state_generation_id
          AND generation.harness_kind = NEW.harness_kind
          AND generation.lifecycle = 'active'
      ) THEN RAISE(ABORT, 'incompatible thread native state generation') END;
    END
  `);

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_runtime_bindings (
      thread_id TEXT PRIMARY KEY,
      connection_id TEXT,
      installation_id TEXT NOT NULL,
      internal_provider_id TEXT,
      model_id TEXT,
      binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES thread_harness_states(thread_id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES provider_connections(connection_id) ON DELETE RESTRICT,
      FOREIGN KEY (installation_id) REFERENCES provider_installations(installation_id) ON DELETE RESTRICT
    )
  `;

  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS thread_runtime_bindings_compatible_insert
    BEFORE INSERT ON thread_runtime_bindings
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM thread_harness_states AS state
        JOIN provider_installations AS installation
          ON installation.installation_id = NEW.installation_id
        LEFT JOIN provider_connections AS connection
          ON connection.connection_id = NEW.connection_id
        WHERE state.thread_id = NEW.thread_id
          AND installation.harness_kind = state.harness_kind
          AND installation.lifecycle = 'active'
          AND (
            NEW.connection_id IS NULL OR
            (connection.harness_kind = state.harness_kind AND connection.lifecycle = 'active')
          )
      ) THEN RAISE(ABORT, 'incompatible thread runtime binding') END;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS thread_runtime_bindings_compatible_update
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
          AND installation.lifecycle = 'active'
          AND (
            NEW.connection_id IS NULL OR
            (connection.harness_kind = state.harness_kind AND connection.lifecycle = 'active')
          )
      ) THEN RAISE(ABORT, 'incompatible thread runtime binding') END;
    END
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS space_connection_defaults (
      space_id TEXT NOT NULL,
      harness_kind TEXT NOT NULL CHECK (${HARNESS_CHECK}),
      connection_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (space_id, harness_kind),
      FOREIGN KEY (space_id) REFERENCES projection_spaces(space_id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES provider_connections(connection_id) ON DELETE RESTRICT
    )
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS space_connection_defaults_compatible_insert
    BEFORE INSERT ON space_connection_defaults
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_connections
        WHERE connection_id = NEW.connection_id
          AND harness_kind = NEW.harness_kind
          AND lifecycle = 'active'
      ) THEN RAISE(ABORT, 'incompatible space connection default') END;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS space_connection_defaults_compatible_update
    BEFORE UPDATE ON space_connection_defaults
    BEGIN
      SELECT CASE WHEN NEW.space_id != OLD.space_id OR NEW.harness_kind != OLD.harness_kind
        THEN RAISE(ABORT, 'space connection default identity is immutable') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_connections
        WHERE connection_id = NEW.connection_id
          AND harness_kind = NEW.harness_kind
          AND lifecycle = 'active'
      ) THEN RAISE(ABORT, 'incompatible space connection default') END;
    END
  `);

  // Only Space defaults fall forward. Existing thread bindings deliberately
  // retain the terminated Connection ID and fail on their next attempted send.
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_connections_replace_terminated_space_default
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

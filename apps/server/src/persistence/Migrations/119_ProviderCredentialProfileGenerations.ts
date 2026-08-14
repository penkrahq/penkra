// FILE: 119_ProviderCredentialProfileGenerations.ts
// Purpose: Decouple stable logical Connections from immutable provider credential profiles.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_credential_profiles (
      profile_ref TEXT PRIMARY KEY,
      harness_kind TEXT NOT NULL,
      authentication_target_id TEXT NOT NULL,
      authentication_method_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('staging', 'active', 'retired', 'removed')),
      connection_id TEXT,
      login_operation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT,
      CHECK (
        (lifecycle = 'staging' AND connection_id IS NULL AND retired_at IS NULL) OR
        (lifecycle = 'active' AND connection_id IS NOT NULL AND retired_at IS NULL) OR
        (lifecycle IN ('retired', 'removed') AND retired_at IS NOT NULL)
      )
    )
  `);
  yield* sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_credential_profiles_active_connection
    ON provider_credential_profiles(connection_id)
    WHERE lifecycle = 'active'
  `);
  yield* sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_credential_profiles_login_operation
    ON provider_credential_profiles(login_operation_id)
    WHERE login_operation_id IS NOT NULL
  `);
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS provider_credential_profiles_lifecycle
    ON provider_credential_profiles(lifecycle, updated_at)
  `);

  // Every released managed Connection used its Connection id as the physical
  // profile identity. Preserve those exact references as the first immutable
  // generation; no credential-bearing directory is moved by this migration.
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO provider_credential_profiles (
      profile_ref, harness_kind, authentication_target_id, authentication_method_id,
      lifecycle, connection_id, login_operation_id, created_at, updated_at, retired_at
    )
    SELECT
      profile_ref, harness_kind, authentication_target_id, authentication_method_id,
      CASE WHEN lifecycle = 'active' THEN 'active' ELSE 'retired' END,
      CASE WHEN lifecycle = 'active' THEN connection_id ELSE NULL END,
      NULL, created_at, updated_at,
      CASE WHEN lifecycle = 'active' THEN NULL ELSE COALESCE(terminated_at, updated_at) END
    FROM provider_connections
    WHERE profile_ref IS NOT NULL
  `);

  // Login journals are the durable inventory of isolated profiles created
  // before this migration. Open attempts remain staging; completed or failed
  // attempts not currently referenced by a Connection are retired for exact
  // startup cleanup.
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO provider_credential_profiles (
      profile_ref, harness_kind, authentication_target_id, authentication_method_id,
      lifecycle, connection_id, login_operation_id, created_at, updated_at, retired_at
    )
    SELECT
      login.profile_ref, login.harness_kind, login.authentication_target_id,
      login.authentication_method_id,
      CASE
        WHEN login.operation_state IN ('starting', 'awaiting-user', 'verified') THEN 'staging'
        ELSE 'retired'
      END,
      NULL, login.operation_id, login.created_at, login.updated_at,
      CASE
        WHEN login.operation_state IN ('starting', 'awaiting-user', 'verified') THEN NULL
        ELSE login.updated_at
      END
    FROM provider_connection_logins AS login
  `);
});

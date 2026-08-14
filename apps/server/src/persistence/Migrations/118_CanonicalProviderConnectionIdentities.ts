// FILE: 118_CanonicalProviderConnectionIdentities.ts
// Purpose: Merge pre-fix Connection rows that represent the same verified provider identity.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TEMP TABLE provider_identity_canonicalization (
      duplicate_connection_id TEXT PRIMARY KEY,
      canonical_connection_id TEXT NOT NULL
    )
  `);

  // Prefer the currently active profile because its on-disk login state is the
  // profile that was actually verified. When every row is terminated, retain
  // the oldest durable identity and let a future exact login reactivate it.
  yield* sql.unsafe(`
    INSERT INTO provider_identity_canonicalization (
      duplicate_connection_id, canonical_connection_id
    )
    SELECT duplicate.connection_id, (
      SELECT canonical.connection_id
      FROM provider_connections AS canonical
      WHERE canonical.harness_kind = duplicate.harness_kind
        AND canonical.authentication_target_id = duplicate.authentication_target_id
        AND canonical.provider_identity_id = duplicate.provider_identity_id
      ORDER BY
        CASE canonical.lifecycle WHEN 'active' THEN 0 ELSE 1 END,
        canonical.created_at ASC,
        canonical.connection_id ASC
      LIMIT 1
    )
    FROM provider_connections AS duplicate
    WHERE duplicate.provider_identity_id IS NOT NULL
      AND duplicate.provider_identity_id NOT LIKE 'superseded:%'
      AND duplicate.connection_id != (
        SELECT canonical.connection_id
        FROM provider_connections AS canonical
        WHERE canonical.harness_kind = duplicate.harness_kind
          AND canonical.authentication_target_id = duplicate.authentication_target_id
          AND canonical.provider_identity_id = duplicate.provider_identity_id
        ORDER BY
          CASE canonical.lifecycle WHEN 'active' THEN 0 ELSE 1 END,
          canonical.created_at ASC,
          canonical.connection_id ASC
        LIMIT 1
      )
  `);

  // Only an active canonical profile may receive live defaults and bindings.
  // Groups with no active profile remain unavailable until that exact identity
  // signs in again; reactivateIdentity performs the same deterministic merge.
  yield* sql.unsafe(`
    UPDATE thread_runtime_bindings
    SET connection_id = (
      SELECT mapping.canonical_connection_id
      FROM provider_identity_canonicalization AS mapping
      WHERE mapping.duplicate_connection_id = thread_runtime_bindings.connection_id
    ),
    binding_revision = binding_revision + 1,
    updated_at = (
      SELECT canonical.updated_at
      FROM provider_identity_canonicalization AS mapping
      JOIN provider_connections AS canonical
        ON canonical.connection_id = mapping.canonical_connection_id
      WHERE mapping.duplicate_connection_id = thread_runtime_bindings.connection_id
    )
    WHERE connection_id IN (
      SELECT mapping.duplicate_connection_id
      FROM provider_identity_canonicalization AS mapping
      JOIN provider_connections AS canonical
        ON canonical.connection_id = mapping.canonical_connection_id
      WHERE canonical.lifecycle = 'active'
    )
  `);

  yield* sql.unsafe(`
    UPDATE space_connection_defaults
    SET connection_id = (
      SELECT mapping.canonical_connection_id
      FROM provider_identity_canonicalization AS mapping
      WHERE mapping.duplicate_connection_id = space_connection_defaults.connection_id
    ),
    updated_at = (
      SELECT canonical.updated_at
      FROM provider_identity_canonicalization AS mapping
      JOIN provider_connections AS canonical
        ON canonical.connection_id = mapping.canonical_connection_id
      WHERE mapping.duplicate_connection_id = space_connection_defaults.connection_id
    )
    WHERE connection_id IN (
      SELECT mapping.duplicate_connection_id
      FROM provider_identity_canonicalization AS mapping
      JOIN provider_connections AS canonical
        ON canonical.connection_id = mapping.canonical_connection_id
      WHERE canonical.lifecycle = 'active'
    )
  `);

  // Preserve historical rows for audit/FK integrity, but remove their claim on
  // the verified provider identity so the identity has exactly one owner.
  yield* sql.unsafe(`
    UPDATE provider_connections
    SET provider_identity_id = 'superseded:' || (
      SELECT mapping.canonical_connection_id
      FROM provider_identity_canonicalization AS mapping
      WHERE mapping.duplicate_connection_id = provider_connections.connection_id
    ) || ':' || connection_id,
    lifecycle = CASE lifecycle WHEN 'active' THEN 'terminated' ELSE lifecycle END,
    termination_reason = CASE lifecycle WHEN 'active' THEN 'removed' ELSE termination_reason END,
    terminated_at = CASE lifecycle WHEN 'active' THEN updated_at ELSE terminated_at END,
    health_status = CASE lifecycle WHEN 'active' THEN 'unavailable' ELSE health_status END
    WHERE connection_id IN (
      SELECT duplicate_connection_id FROM provider_identity_canonicalization
    )
  `);

  yield* sql`DROP TABLE provider_identity_canonicalization`;
  yield* sql`DROP INDEX IF EXISTS provider_connections_active_identity`;
  yield* sql`DROP INDEX IF EXISTS provider_connections_verified_identity`;
  yield* sql.unsafe(`
    CREATE UNIQUE INDEX provider_connections_verified_identity
    ON provider_connections(harness_kind, authentication_target_id, provider_identity_id)
    WHERE provider_identity_id IS NOT NULL
  `);
});

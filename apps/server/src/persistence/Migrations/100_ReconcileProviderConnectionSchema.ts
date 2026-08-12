// FILE: 100_ReconcileProviderConnectionSchema.ts
// Purpose: Reconciles every pre-release migration-098 schema shape before native-state adoption.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProviderConnectionsAndBindings from "./098_ProviderConnectionsAndBindings.ts";

interface TableColumn {
  readonly name: string;
}

// An early migration-098 build created thread_harness_states without a revision
// column and with a three-provider CHECK constraint. CREATE TABLE IF NOT EXISTS
// cannot repair either difference. Rebuild the two related tables exactly once
// so the recorded pre-release database reaches the same provider-neutral schema
// as a fresh installation, without a runtime compatibility path.
const reconcileLegacyThreadBindingTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql.unsafe<TableColumn>("PRAGMA table_info(thread_harness_states)");
  if (columns.length === 0 || columns.some((column) => column.name === "state_revision")) return;

  yield* sql`DROP TRIGGER IF EXISTS thread_runtime_bindings_compatible_update`;
  yield* sql`DROP TRIGGER IF EXISTS thread_runtime_bindings_compatible_insert`;
  yield* sql`DROP TRIGGER IF EXISTS thread_harness_states_compatible_update`;
  yield* sql`DROP TRIGGER IF EXISTS thread_harness_states_compatible_insert`;

  yield* sql.unsafe(`
    CREATE TABLE thread_harness_states_reconciled (
      thread_id TEXT PRIMARY KEY,
      harness_kind TEXT NOT NULL CHECK (length(trim(harness_kind)) > 0),
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
  yield* sql`
    INSERT INTO thread_harness_states_reconciled (
      thread_id, harness_kind, native_state_generation_id, provider_session_id,
      native_state_locator_json, last_verified_resume_at, state_revision, created_at, updated_at
    )
    SELECT
      thread_id, harness_kind, native_state_generation_id, provider_session_id,
      native_state_locator_json, last_verified_resume_at, 0, created_at, updated_at
    FROM thread_harness_states
  `;

  yield* sql.unsafe(`
    CREATE TABLE thread_runtime_bindings_reconciled (
      thread_id TEXT PRIMARY KEY,
      connection_id TEXT,
      installation_id TEXT NOT NULL,
      internal_provider_id TEXT,
      model_id TEXT,
      binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id)
        REFERENCES thread_harness_states_reconciled(thread_id) ON DELETE CASCADE,
      FOREIGN KEY (connection_id) REFERENCES provider_connections(connection_id) ON DELETE RESTRICT,
      FOREIGN KEY (installation_id) REFERENCES provider_installations(installation_id) ON DELETE RESTRICT
    )
  `);
  yield* sql`
    INSERT INTO thread_runtime_bindings_reconciled (
      thread_id, connection_id, installation_id, internal_provider_id, model_id,
      binding_revision, created_at, updated_at
    )
    SELECT
      thread_id, connection_id, installation_id, internal_provider_id, model_id,
      binding_revision, created_at, updated_at
    FROM thread_runtime_bindings
  `;

  yield* sql`DROP TABLE thread_runtime_bindings`;
  yield* sql`DROP TABLE thread_harness_states`;
  yield* sql`ALTER TABLE thread_harness_states_reconciled RENAME TO thread_harness_states`;
  yield* sql`ALTER TABLE thread_runtime_bindings_reconciled RENAME TO thread_runtime_bindings`;
});

export default Effect.gen(function* () {
  yield* reconcileLegacyThreadBindingTables;
  // Development profiles may already have recorded migration 098 from before
  // all provider-connection tables were added. Replaying the final idempotent
  // body restores those omitted tables and recreates the reconciled triggers.
  yield* ProviderConnectionsAndBindings;
});

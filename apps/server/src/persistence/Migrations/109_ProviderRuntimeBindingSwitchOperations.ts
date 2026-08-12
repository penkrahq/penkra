// FILE: 109_ProviderRuntimeBindingSwitchOperations.ts
// Purpose: Represent model-only runtime-binding changes without inventing native state.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`DROP TRIGGER IF EXISTS provider_thread_switch_operations_valid_transition`);
  yield* sql.unsafe(`DROP INDEX IF EXISTS provider_thread_switch_operations_one_open_per_thread`);
  yield* sql.unsafe(`
    ALTER TABLE provider_thread_switch_operations
      RENAME TO provider_thread_switch_operations_legacy
  `);
  const legacyColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_thread_switch_operations_legacy)
  `;
  const legacyColumnNames = new Set(legacyColumns.map((column) => column.name));
  // The first on-machine v99 schema predates these nullable result fields.
  // Normalize that exact recorded lineage before the table is rebuilt below.
  if (!legacyColumnNames.has("cwd")) {
    yield* sql.unsafe(`
      ALTER TABLE provider_thread_switch_operations_legacy
        ADD COLUMN cwd TEXT
    `);
  }
  if (!legacyColumnNames.has("verification_json")) {
    yield* sql.unsafe(`
      ALTER TABLE provider_thread_switch_operations_legacy
        ADD COLUMN verification_json TEXT
    `);
  }
  if (!legacyColumnNames.has("failure_reason")) {
    yield* sql.unsafe(`
      ALTER TABLE provider_thread_switch_operations_legacy
        ADD COLUMN failure_reason TEXT
    `);
  }
  yield* sql.unsafe(`
    CREATE TABLE provider_thread_switch_operations (
      operation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('native-state', 'runtime-binding')),
      operation_state TEXT NOT NULL CHECK (operation_state IN (
        'pending', 'interrupted', 'verified', 'committed', 'failed'
      )),
      source_state_revision INTEGER NOT NULL CHECK (source_state_revision >= 0),
      source_binding_revision INTEGER NOT NULL CHECK (source_binding_revision >= 0),
      target_native_state_generation_id TEXT UNIQUE,
      selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
      command_json TEXT NOT NULL CHECK (json_valid(command_json)),
      cwd TEXT,
      verification_json TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (operation_kind = 'native-state' AND target_native_state_generation_id IS NOT NULL) OR
        (operation_kind = 'runtime-binding' AND target_native_state_generation_id IS NULL)
      ),
      CHECK (
        (operation_state = 'failed' AND failure_reason IS NOT NULL) OR
        (operation_state != 'failed' AND failure_reason IS NULL)
      )
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO provider_thread_switch_operations (
      operation_id, thread_id, command_id, operation_kind, operation_state,
      source_state_revision, source_binding_revision, target_native_state_generation_id,
      selection_json, command_json, cwd, verification_json, failure_reason, created_at, updated_at
    )
    SELECT
      operation_id, thread_id, command_id, 'native-state', operation_state,
      source_state_revision, source_binding_revision, target_native_state_generation_id,
      selection_json, command_json, cwd, verification_json, failure_reason, created_at, updated_at
    FROM provider_thread_switch_operations_legacy
  `);
  yield* sql.unsafe(`DROP TABLE provider_thread_switch_operations_legacy`);
  yield* sql.unsafe(`
    CREATE UNIQUE INDEX provider_thread_switch_operations_one_open_per_thread
    ON provider_thread_switch_operations(thread_id)
    WHERE operation_state NOT IN ('committed', 'failed')
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER provider_thread_switch_operations_valid_transition
    BEFORE UPDATE ON provider_thread_switch_operations
    BEGIN
      SELECT CASE WHEN
        NEW.operation_id != OLD.operation_id OR
        NEW.thread_id != OLD.thread_id OR
        NEW.command_id != OLD.command_id OR
        NEW.operation_kind != OLD.operation_kind OR
        NEW.source_state_revision != OLD.source_state_revision OR
        NEW.source_binding_revision != OLD.source_binding_revision OR
        NEW.target_native_state_generation_id IS NOT OLD.target_native_state_generation_id OR
        NEW.selection_json != OLD.selection_json OR
        NEW.command_json != OLD.command_json OR
        NEW.cwd IS NOT OLD.cwd OR
        NEW.created_at != OLD.created_at
      THEN RAISE(ABORT, 'provider thread switch operation identity is immutable') END;
      SELECT CASE WHEN NOT (
        (OLD.operation_state = 'pending' AND NEW.operation_state IN ('interrupted', 'failed')) OR
        (OLD.operation_state = 'interrupted' AND NEW.operation_state IN ('verified', 'failed')) OR
        (OLD.operation_state = 'verified' AND NEW.operation_state IN ('committed', 'failed'))
      ) THEN RAISE(ABORT, 'invalid provider thread switch operation transition') END;
    END
  `);
});

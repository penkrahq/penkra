// FILE: 099_ProviderThreadSwitchOperations.ts
// Purpose: Durable, crash-recoverable journal for send-time Connection switches.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_thread_switch_operations (
      operation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      operation_state TEXT NOT NULL CHECK (operation_state IN (
        'pending', 'interrupted', 'verified', 'committed', 'failed'
      )),
      source_state_revision INTEGER NOT NULL CHECK (source_state_revision >= 0),
      source_binding_revision INTEGER NOT NULL CHECK (source_binding_revision >= 0),
      target_native_state_generation_id TEXT NOT NULL UNIQUE,
      selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
      command_json TEXT NOT NULL CHECK (json_valid(command_json)),
      cwd TEXT,
      verification_json TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
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
    CREATE UNIQUE INDEX IF NOT EXISTS provider_thread_switch_operations_one_open_per_thread
    ON provider_thread_switch_operations(thread_id)
    WHERE operation_state NOT IN ('committed', 'failed')
  `;
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_thread_switch_operations_valid_transition
    BEFORE UPDATE ON provider_thread_switch_operations
    BEGIN
      SELECT CASE WHEN
        NEW.operation_id != OLD.operation_id OR
        NEW.thread_id != OLD.thread_id OR
        NEW.command_id != OLD.command_id OR
        NEW.source_state_revision != OLD.source_state_revision OR
        NEW.source_binding_revision != OLD.source_binding_revision OR
        NEW.target_native_state_generation_id != OLD.target_native_state_generation_id OR
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

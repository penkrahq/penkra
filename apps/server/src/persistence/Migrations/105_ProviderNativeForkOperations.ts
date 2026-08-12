// FILE: 105_ProviderNativeForkOperations.ts
// Purpose: Durable crash journal for exact provider-native thread forks.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_native_fork_operations (
      operation_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL UNIQUE,
      source_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      operation_state TEXT NOT NULL CHECK (operation_state IN (
        'pending', 'materialized', 'forked', 'committed', 'failed'
      )),
      source_state_revision INTEGER NOT NULL CHECK (source_state_revision >= 0),
      source_binding_revision INTEGER NOT NULL CHECK (source_binding_revision >= 0),
      target_native_state_generation_id TEXT NOT NULL UNIQUE,
      selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
      command_json TEXT NOT NULL CHECK (json_valid(command_json)),
      cwd TEXT,
      fork_result_json TEXT CHECK (fork_result_json IS NULL OR json_valid(fork_result_json)),
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (operation_state = 'failed' AND failure_reason IS NOT NULL) OR
        (operation_state != 'failed' AND failure_reason IS NULL)
      )
    )
  `);
  yield* sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_native_fork_operations_one_open_per_target
    ON provider_native_fork_operations(target_thread_id)
    WHERE operation_state NOT IN ('committed', 'failed')
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_native_fork_operations_valid_transition
    BEFORE UPDATE ON provider_native_fork_operations
    BEGIN
      SELECT CASE WHEN
        NEW.operation_id != OLD.operation_id OR NEW.command_id != OLD.command_id OR
        NEW.source_thread_id != OLD.source_thread_id OR
        NEW.target_thread_id != OLD.target_thread_id OR
        NEW.source_state_revision != OLD.source_state_revision OR
        NEW.source_binding_revision != OLD.source_binding_revision OR
        NEW.target_native_state_generation_id != OLD.target_native_state_generation_id OR
        NEW.selection_json != OLD.selection_json OR NEW.command_json != OLD.command_json OR
        NEW.cwd IS NOT OLD.cwd OR NEW.created_at != OLD.created_at
      THEN RAISE(ABORT, 'provider native fork operation identity is immutable') END;
      SELECT CASE WHEN NOT (
        (OLD.operation_state = 'pending' AND NEW.operation_state IN ('materialized', 'failed')) OR
        (OLD.operation_state = 'materialized' AND NEW.operation_state IN ('forked', 'failed')) OR
        (OLD.operation_state = 'forked' AND NEW.operation_state IN ('committed', 'failed'))
      ) THEN RAISE(ABORT, 'invalid provider native fork operation transition') END;
    END
  `);
});

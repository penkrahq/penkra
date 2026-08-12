// FILE: 110_SettleProviderSwitchSource.ts
// Purpose: Let a pending switch atomically adopt the exact source persisted by turn settlement.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`DROP TRIGGER IF EXISTS provider_thread_switch_operations_valid_transition`);
  yield* sql.unsafe(`
    CREATE TRIGGER provider_thread_switch_operations_valid_transition
    BEFORE UPDATE ON provider_thread_switch_operations
    BEGIN
      SELECT CASE WHEN
        NEW.operation_id != OLD.operation_id OR
        NEW.thread_id != OLD.thread_id OR
        NEW.command_id != OLD.command_id OR
        NEW.operation_kind != OLD.operation_kind OR
        NEW.target_native_state_generation_id IS NOT OLD.target_native_state_generation_id OR
        NEW.command_json != OLD.command_json OR
        NEW.cwd IS NOT OLD.cwd OR
        NEW.created_at != OLD.created_at OR
        (
          (
            NEW.source_state_revision != OLD.source_state_revision OR
            NEW.source_binding_revision != OLD.source_binding_revision OR
            NEW.selection_json != OLD.selection_json
          ) AND NOT (
            OLD.operation_state = 'pending' AND NEW.operation_state = 'interrupted'
          )
        )
      THEN RAISE(ABORT, 'provider thread switch operation identity is immutable') END;
      SELECT CASE WHEN NOT (
        (OLD.operation_state = 'pending' AND NEW.operation_state IN ('interrupted', 'failed')) OR
        (OLD.operation_state = 'interrupted' AND NEW.operation_state IN ('verified', 'failed')) OR
        (OLD.operation_state = 'verified' AND NEW.operation_state IN ('committed', 'failed'))
      ) THEN RAISE(ABORT, 'invalid provider thread switch operation transition') END;
    END
  `);
});

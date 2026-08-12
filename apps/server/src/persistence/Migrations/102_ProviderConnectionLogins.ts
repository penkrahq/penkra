// FILE: 102_ProviderConnectionLogins.ts
// Purpose: Journals provider-owned account login without persisting login URLs or tokens.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_connection_logins (
      operation_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL UNIQUE,
      harness_kind TEXT NOT NULL,
      authentication_target_id TEXT NOT NULL,
      authentication_method_id TEXT NOT NULL,
      label TEXT NOT NULL CHECK (length(trim(label)) > 0),
      profile_ref TEXT NOT NULL UNIQUE,
      provider_login_id TEXT,
      operation_state TEXT NOT NULL CHECK (operation_state IN (
        'starting', 'awaiting-user', 'verified', 'completed', 'failed', 'cancelled'
      )),
      provider_identity_id TEXT,
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
    CREATE TRIGGER IF NOT EXISTS provider_connection_logins_valid_transition
    BEFORE UPDATE ON provider_connection_logins
    BEGIN
      SELECT CASE WHEN
        NEW.operation_id != OLD.operation_id OR
        NEW.connection_id != OLD.connection_id OR
        NEW.harness_kind != OLD.harness_kind OR
        NEW.authentication_target_id != OLD.authentication_target_id OR
        NEW.authentication_method_id != OLD.authentication_method_id OR
        NEW.label != OLD.label OR
        NEW.profile_ref != OLD.profile_ref OR
        NEW.created_at != OLD.created_at
      THEN RAISE(ABORT, 'provider connection login identity is immutable') END;
      SELECT CASE WHEN NOT (
        (OLD.operation_state = 'starting' AND NEW.operation_state IN ('awaiting-user', 'failed', 'cancelled')) OR
        (OLD.operation_state = 'awaiting-user' AND NEW.operation_state IN ('verified', 'failed', 'cancelled')) OR
        (OLD.operation_state = 'verified' AND NEW.operation_state IN ('completed', 'failed'))
      ) THEN RAISE(ABORT, 'invalid provider connection login transition') END;
    END
  `);
});

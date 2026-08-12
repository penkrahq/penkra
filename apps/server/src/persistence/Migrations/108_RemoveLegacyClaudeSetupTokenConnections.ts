// FILE: 108_RemoveLegacyClaudeSetupTokenConnections.ts
// Purpose: Journals exact removal of the pre-release Claude setup-token backend.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO provider_connection_operations (
      operation_id,
      connection_id,
      operation_kind,
      operation_state,
      credential_ref,
      payload_json,
      failure_reason,
      created_at,
      updated_at
    )
    SELECT
      'remove-legacy-claude-setup-token:' || connection_id,
      connection_id,
      'terminate',
      'pending',
      credential_ref,
      json_object(
        'reason', 'removed',
        'terminatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ),
      NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM provider_connections
    WHERE harness_kind = 'claudeAgent'
      AND authentication_target_id = 'anthropic-first-party'
      AND authentication_method_id = 'subscription-token'
      AND credential_ref IS NOT NULL
      AND profile_ref IS NULL
  `);
});

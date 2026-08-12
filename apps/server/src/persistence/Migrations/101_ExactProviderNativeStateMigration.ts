// FILE: 101_ExactProviderNativeStateMigration.ts
// Purpose: Preserve exact legacy resume identities without pretending their native files are managed.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 098 briefly wrote projection metadata as though it were a native
  // cursor. It was never safe to resume and must not survive as a fallback.
  yield* sql`
    DELETE FROM thread_harness_states
    WHERE native_state_generation_id IN (
      SELECT native_state_generation_id
      FROM provider_native_state_generations
      WHERE adapter_schema_version = 'legacy-projection-v1'
    )
  `;
  yield* sql`
    DELETE FROM provider_native_state_generations
    WHERE adapter_schema_version = 'legacy-projection-v1'
  `;

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_native_state_migrations (
      native_state_generation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      harness_kind TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind = 'legacy-provider-profile'),
      source_locator_json TEXT NOT NULL CHECK (json_valid(source_locator_json)),
      migration_state TEXT NOT NULL CHECK (migration_state IN (
        'pending', 'preserving', 'preserved', 'binding', 'bound', 'failed'
      )),
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (migration_state = 'failed' AND failure_reason IS NOT NULL) OR
        (migration_state != 'failed' AND failure_reason IS NULL)
      ),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      FOREIGN KEY (native_state_generation_id)
        REFERENCES provider_native_state_generations(native_state_generation_id) ON DELETE RESTRICT
    )
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_native_state_migrations_immutable_identity
    BEFORE UPDATE ON provider_native_state_migrations
    WHEN
      OLD.native_state_generation_id != NEW.native_state_generation_id OR
      OLD.thread_id != NEW.thread_id OR
      OLD.harness_kind != NEW.harness_kind OR
      OLD.source_kind != NEW.source_kind OR
      OLD.source_locator_json != NEW.source_locator_json OR
      OLD.created_at != NEW.created_at
    BEGIN
      SELECT RAISE(ABORT, 'provider native-state migration identity is immutable');
    END
  `);

  // A cursor proves identity, not that the provider's native files have been
  // copied into the Penkra-owned generation. Keep these generations explicitly
  // pending and omit the runtime binding until preservation and the operator's
  // same-harness Connection mapping have both been verified.
  yield* sql`
    INSERT INTO provider_native_state_generations (
      native_state_generation_id, harness_kind, adapter_schema_version,
      state_manifest_json, lifecycle, created_at
    )
    SELECT
      'migrated-native:' || runtime.thread_id,
      runtime.provider_name,
      'legacy-native-state-pending-v1',
      json_object(
        'format', 'legacy-native-state-pending-v1',
        'source', 'provider_session_runtime',
        'resumeCursor', json(runtime.resume_cursor_json)
      ),
      'active',
      runtime.last_seen_at
    FROM provider_session_runtime AS runtime
    JOIN projection_threads AS thread ON thread.thread_id = runtime.thread_id
    WHERE runtime.resume_cursor_json IS NOT NULL
      AND json_valid(runtime.resume_cursor_json)
      AND (
        (runtime.provider_name = 'codex' AND
          length(trim(COALESCE(json_extract(runtime.resume_cursor_json, '$.threadId'), ''))) > 0) OR
        (runtime.provider_name = 'claudeAgent' AND
          length(trim(COALESCE(json_extract(runtime.resume_cursor_json, '$.resume'), ''))) > 0) OR
        (runtime.provider_name = 'opencode' AND (
          (json_type(runtime.resume_cursor_json) = 'text' AND
            length(trim(json_extract(runtime.resume_cursor_json, '$'))) > 0) OR
          length(trim(COALESCE(json_extract(runtime.resume_cursor_json, '$.openCodeSessionId'), ''))) > 0
        ))
      )
    ON CONFLICT (native_state_generation_id) DO NOTHING
  `;
  yield* sql`
    INSERT INTO thread_harness_states (
      thread_id, harness_kind, native_state_generation_id, provider_session_id,
      native_state_locator_json, last_verified_resume_at, state_revision,
      created_at, updated_at
    )
    SELECT
      runtime.thread_id,
      runtime.provider_name,
      'migrated-native:' || runtime.thread_id,
      CASE runtime.provider_name
        WHEN 'codex' THEN trim(json_extract(runtime.resume_cursor_json, '$.threadId'))
        WHEN 'claudeAgent' THEN trim(json_extract(runtime.resume_cursor_json, '$.resume'))
        WHEN 'opencode' THEN CASE
          WHEN json_type(runtime.resume_cursor_json) = 'text'
            THEN trim(json_extract(runtime.resume_cursor_json, '$'))
          ELSE trim(json_extract(runtime.resume_cursor_json, '$.openCodeSessionId'))
        END
      END,
      runtime.resume_cursor_json,
      NULL,
      0,
      runtime.last_seen_at,
      runtime.last_seen_at
    FROM provider_session_runtime AS runtime
    JOIN provider_native_state_generations AS generation
      ON generation.native_state_generation_id = 'migrated-native:' || runtime.thread_id
    ON CONFLICT (thread_id) DO NOTHING
  `;
  yield* sql`
    INSERT INTO provider_native_state_migrations (
      native_state_generation_id, thread_id, harness_kind, source_kind,
      source_locator_json, migration_state, failure_reason, created_at, updated_at
    )
    SELECT
      state.native_state_generation_id,
      state.thread_id,
      state.harness_kind,
      'legacy-provider-profile',
      state.native_state_locator_json,
      'pending',
      NULL,
      state.created_at,
      state.updated_at
    FROM thread_harness_states AS state
    JOIN provider_native_state_generations AS generation
      ON generation.native_state_generation_id = state.native_state_generation_id
    WHERE generation.adapter_schema_version = 'legacy-native-state-pending-v1'
    ON CONFLICT (native_state_generation_id) DO NOTHING
  `;
});

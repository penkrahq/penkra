// FILE: 104_ProviderNativeStateOwnership.ts
// Purpose: Durable per-thread native-generation ownership and crash-safe deletion work.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Some development databases recorded migration 101 before this durable
  // migration journal became part of its final schema. Establish the exact
  // forward schema here, before ownership reads it, so an already-recorded
  // migration is never assumed to have effects that are absent on disk.
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

  const generationColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_native_state_generations)
  `;
  if (!generationColumns.some((column) => column.name === "owner_thread_id")) {
    yield* sql.unsafe(`
      ALTER TABLE provider_native_state_generations
      ADD COLUMN owner_thread_id TEXT
    `);
  }
  yield* sql`
    UPDATE provider_native_state_generations AS generation
    SET owner_thread_id = (
      SELECT state.thread_id
      FROM thread_harness_states AS state
      WHERE state.native_state_generation_id = generation.native_state_generation_id
      LIMIT 1
    )
    WHERE owner_thread_id IS NULL
  `;
  // Verified switches record the exact source generation in their immutable
  // manifest. Walk that lineage from the current thread state so retained
  // generations inherit the same owner without title/path/order inference.
  yield* sql.unsafe(`
    WITH RECURSIVE generation_owners(generation_id, thread_id) AS (
      SELECT native_state_generation_id, thread_id
      FROM thread_harness_states
      UNION
      SELECT
        json_extract(generation.state_manifest_json, '$.sourceGenerationId'),
        generation_owners.thread_id
      FROM generation_owners
      JOIN provider_native_state_generations AS generation
        ON generation.native_state_generation_id = generation_owners.generation_id
      WHERE json_type(generation.state_manifest_json, '$.sourceGenerationId') = 'text'
    )
    UPDATE provider_native_state_generations AS generation
    SET owner_thread_id = (
      SELECT generation_owners.thread_id
      FROM generation_owners
      WHERE generation_owners.generation_id = generation.native_state_generation_id
      LIMIT 1
    )
    WHERE generation.owner_thread_id IS NULL
      AND EXISTS (
        SELECT 1 FROM generation_owners
        WHERE generation_owners.generation_id = generation.native_state_generation_id
      )
  `);
  yield* sql`
    UPDATE provider_native_state_generations AS generation
    SET owner_thread_id = (
      SELECT migration.thread_id
      FROM provider_native_state_migrations AS migration
      WHERE migration.native_state_generation_id = generation.native_state_generation_id
      LIMIT 1
    )
    WHERE owner_thread_id IS NULL
  `;
  const unowned = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count
    FROM provider_native_state_generations
    WHERE owner_thread_id IS NULL OR length(trim(owner_thread_id)) = 0
  `;
  if ((unowned[0]?.count ?? 0) !== 0) {
    return yield* Effect.fail(
      new Error("Provider native-state ownership could not be proven for every generation."),
    );
  }

  // New bindings still require the active installation through the insert
  // trigger. Existing bindings are immutable-version pins and may advance
  // their Connection/model revision while that exact generation is retained.
  yield* sql.unsafe(`DROP TRIGGER IF EXISTS thread_runtime_bindings_compatible_update`);
  yield* sql.unsafe(`
    CREATE TRIGGER thread_runtime_bindings_compatible_update
    BEFORE UPDATE ON thread_runtime_bindings
    BEGIN
      SELECT CASE WHEN NEW.thread_id != OLD.thread_id
        THEN RAISE(ABORT, 'thread binding identity is immutable') END;
      SELECT CASE WHEN NEW.installation_id != OLD.installation_id
        THEN RAISE(ABORT, 'thread installation binding is immutable') END;
      SELECT CASE WHEN NEW.binding_revision != OLD.binding_revision + 1
        THEN RAISE(ABORT, 'thread binding revision must increment exactly once') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM thread_harness_states AS state
        JOIN provider_installations AS installation
          ON installation.installation_id = NEW.installation_id
        LEFT JOIN provider_connections AS connection
          ON connection.connection_id = NEW.connection_id
        WHERE state.thread_id = NEW.thread_id
          AND installation.harness_kind = state.harness_kind
          AND installation.lifecycle IN ('active', 'retired')
          AND (
            NEW.connection_id IS NULL OR
            (connection.harness_kind = state.harness_kind AND connection.lifecycle = 'active')
          )
      ) THEN RAISE(ABORT, 'incompatible thread runtime binding') END;
    END
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS provider_native_state_deletions (
      native_state_generation_id TEXT PRIMARY KEY,
      owner_thread_id TEXT NOT NULL,
      deletion_state TEXT NOT NULL CHECK (deletion_state IN ('pending', 'deleting')),
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_native_state_generations_require_owner_insert
    BEFORE INSERT ON provider_native_state_generations
    WHEN NEW.owner_thread_id IS NULL OR length(trim(NEW.owner_thread_id)) = 0
    BEGIN
      SELECT RAISE(ABORT, 'provider native-state generation requires an owner thread');
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS provider_native_state_generations_immutable_owner
    BEFORE UPDATE OF owner_thread_id ON provider_native_state_generations
    WHEN OLD.owner_thread_id IS NOT NEW.owner_thread_id
    BEGIN
      SELECT RAISE(ABORT, 'provider native-state generation owner is immutable');
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_threads_enqueue_native_state_deletion
    AFTER DELETE ON projection_threads
    BEGIN
      INSERT INTO provider_native_state_deletions (
        native_state_generation_id, owner_thread_id, deletion_state,
        failure_reason, created_at, updated_at
      )
      SELECT native_state_generation_id, OLD.thread_id, 'pending', NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM provider_native_state_generations
      WHERE owner_thread_id = OLD.thread_id
      ON CONFLICT (native_state_generation_id) DO NOTHING;
    END
  `);
});

// FILE: 148_RemoveUnshippedProviders.ts
// Purpose: Deletes persisted state for provider integrations removed before product release.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const REMOVED_PROVIDERS_SQL = "'cursor', 'antigravity', 'grok', 'droid', 'kilo', 'pi'";
const CODEX_DEFAULT_SELECTION = '{"provider":"codex","model":"gpt-5.5"}';

interface SqliteTable {
  readonly name: string;
}

interface SqliteColumn {
  readonly name: string;
}

function quotedIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQLite identifier in provider-removal migration: ${value}`);
  }
  return `"${value}"`;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TEMP TABLE removed_provider_threads (thread_id TEXT PRIMARY KEY)
  `);
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO removed_provider_threads (thread_id)
    SELECT thread_id
    FROM projection_threads
    WHERE json_extract(model_selection_json, '$.provider') IN (${REMOVED_PROVIDERS_SQL})
  `);
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO removed_provider_threads (thread_id)
    SELECT stream_id
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.created'
      AND json_extract(payload_json, '$.modelSelection.provider') IN (${REMOVED_PROVIDERS_SQL})
  `);

  yield* sql.unsafe(`
    CREATE TEMP TABLE removed_provider_connections (connection_id TEXT PRIMARY KEY)
  `);
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO removed_provider_connections (connection_id)
    SELECT connection_id
    FROM provider_connections
    WHERE harness_kind IN (${REMOVED_PROVIDERS_SQL})
  `);

  yield* sql.unsafe(`
    CREATE TEMP TABLE removed_provider_commands (command_id TEXT PRIMARY KEY)
  `);
  yield* sql.unsafe(`
    INSERT OR IGNORE INTO removed_provider_commands (command_id)
    SELECT DISTINCT command_id
    FROM orchestration_events
    WHERE command_id IS NOT NULL
      AND aggregate_kind = 'thread'
      AND (
        stream_id IN (SELECT thread_id FROM removed_provider_threads)
        OR json_extract(payload_json, '$.threadId') IN (
          SELECT thread_id FROM removed_provider_threads
        )
      )
  `);

  // Defer relationships while every thread-owned table is cleared. Discovering
  // thread_id columns keeps this cut complete as the schema grows.
  yield* sql.unsafe("PRAGMA defer_foreign_keys = ON");
  const tables = yield* sql.unsafe<SqliteTable>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'removed_provider_%'
      AND name NOT IN ('projection_threads', 'orchestration_events')
  `);
  for (const table of tables) {
    const identifier = quotedIdentifier(table.name);
    const columns = yield* sql.unsafe<SqliteColumn>(`PRAGMA table_info(${identifier})`);
    if (columns.some((column) => column.name === "thread_id")) {
      yield* sql.unsafe(
        `DELETE FROM ${identifier} WHERE thread_id IN (SELECT thread_id FROM removed_provider_threads)`,
      );
    }
  }

  yield* sql.unsafe(`
    DELETE FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND (
        stream_id IN (SELECT thread_id FROM removed_provider_threads)
        OR json_extract(payload_json, '$.threadId') IN (
          SELECT thread_id FROM removed_provider_threads
        )
      )
  `);
  yield* sql.unsafe(`
    DELETE FROM orchestration_command_receipts
    WHERE command_id IN (SELECT command_id FROM removed_provider_commands)
  `);
  yield* sql.unsafe(`
    DELETE FROM projection_threads
    WHERE thread_id IN (SELECT thread_id FROM removed_provider_threads)
  `);

  // Surviving folders must not retain a default that the narrowed contract can
  // no longer decode. Rewrite both the projection and its authoritative events.
  yield* sql.unsafe(`
    UPDATE projection_projects
    SET default_model_selection_json = '${CODEX_DEFAULT_SELECTION}'
    WHERE json_extract(default_model_selection_json, '$.provider') IN (${REMOVED_PROVIDERS_SQL})
  `);
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModelSelection',
      json('${CODEX_DEFAULT_SELECTION}')
    )
    WHERE json_extract(payload_json, '$.defaultModelSelection.provider')
      IN (${REMOVED_PROVIDERS_SQL})
  `);

  yield* sql.unsafe(`
    DELETE FROM provider_connection_operations
    WHERE connection_id IN (SELECT connection_id FROM removed_provider_connections)
  `);
  yield* sql.unsafe(`
    DELETE FROM provider_connection_logins
    WHERE harness_kind IN (${REMOVED_PROVIDERS_SQL})
       OR connection_id IN (SELECT connection_id FROM removed_provider_connections)
  `);
  yield* sql.unsafe(`
    DELETE FROM provider_connections
    WHERE connection_id IN (SELECT connection_id FROM removed_provider_connections)
  `);

  const providerTables = yield* sql.unsafe<SqliteTable>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE 'removed_provider_%'
  `);
  for (const table of providerTables) {
    const identifier = quotedIdentifier(table.name);
    const columns = yield* sql.unsafe<SqliteColumn>(`PRAGMA table_info(${identifier})`);
    if (columns.some((column) => column.name === "harness_kind")) {
      yield* sql.unsafe(
        `DELETE FROM ${identifier} WHERE harness_kind IN (${REMOVED_PROVIDERS_SQL})`,
      );
    }
    if (columns.some((column) => column.name === "provider")) {
      yield* sql.unsafe(`DELETE FROM ${identifier} WHERE provider IN (${REMOVED_PROVIDERS_SQL})`);
    }
    if (columns.some((column) => column.name === "provider_name")) {
      yield* sql.unsafe(
        `DELETE FROM ${identifier} WHERE provider_name IN (${REMOVED_PROVIDERS_SQL})`,
      );
    }
  }

  yield* sql.unsafe("DROP TABLE removed_provider_commands");
  yield* sql.unsafe("DROP TABLE removed_provider_connections");
  yield* sql.unsafe("DROP TABLE removed_provider_threads");
});

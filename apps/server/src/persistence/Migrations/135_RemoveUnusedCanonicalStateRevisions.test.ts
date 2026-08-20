import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const projectionTables = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_turns",
  "projection_thread_sessions",
  "projection_projects",
  "projection_spaces",
  "projection_pending_interactions",
] as const;

const revisionTables = [
  ...projectionTables,
  "operations",
  "notices",
  "connection_rate_limits",
  "connection_usage_daily",
] as const;

const revisionIndexes = [
  "idx_projection_thread_messages_thread_updated_seq",
  "idx_projection_thread_activities_thread_updated_seq",
  "idx_projection_threads_updated_seq",
  "idx_operations_thread_updated",
  "idx_notices_thread_updated",
] as const;

layer("135_RemoveUnusedCanonicalStateRevisions", (it) => {
  it.effect("removes unused revision writers, columns, indexes, and sequence state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 134 });

      // Reproduce the schema shipped before fresh installs stopped creating revisions.
      yield* sql`
        CREATE TABLE canonical_state_sequence (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          value INTEGER NOT NULL CHECK (value >= 0)
        )
      `;
      yield* sql`INSERT INTO canonical_state_sequence (singleton, value) VALUES (1, 0)`;

      for (const table of revisionTables) {
        yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN updated_seq INTEGER NOT NULL DEFAULT 0`);
      }
      for (const table of projectionTables) {
        yield* sql.unsafe(
          `CREATE TRIGGER ${table}_canonical_revision_insert
           AFTER INSERT ON ${table}
           BEGIN
             UPDATE canonical_state_sequence SET value = value + 1 WHERE singleton = 1;
             UPDATE ${table}
             SET updated_seq = (SELECT value FROM canonical_state_sequence WHERE singleton = 1)
             WHERE rowid = NEW.rowid;
           END`,
        );
        yield* sql.unsafe(
          `CREATE TRIGGER ${table}_canonical_revision_update
           AFTER UPDATE ON ${table}
           WHEN NEW.updated_seq = OLD.updated_seq
           BEGIN
             UPDATE canonical_state_sequence SET value = value + 1 WHERE singleton = 1;
             UPDATE ${table}
             SET updated_seq = (SELECT value FROM canonical_state_sequence WHERE singleton = 1)
             WHERE rowid = NEW.rowid;
           END`,
        );
      }
      yield* sql.unsafe(
        "CREATE INDEX idx_projection_thread_messages_thread_updated_seq ON projection_thread_messages(thread_id, updated_seq)",
      );
      yield* sql.unsafe(
        "CREATE INDEX idx_projection_thread_activities_thread_updated_seq ON projection_thread_activities(thread_id, updated_seq)",
      );
      yield* sql.unsafe(
        "CREATE INDEX idx_projection_threads_updated_seq ON projection_threads(updated_seq)",
      );
      yield* sql.unsafe(
        "CREATE INDEX idx_operations_thread_updated ON operations(thread_id, updated_seq)",
      );
      yield* sql.unsafe(
        "CREATE INDEX idx_notices_thread_updated ON notices(thread_id, updated_seq)",
      );

      yield* runMigrations({ toMigrationInclusive: 135 });

      for (const table of revisionTables) {
        const columns = yield* sql.unsafe<{ readonly name: string }>(
          `SELECT name FROM pragma_table_info('${table}') WHERE name = 'updated_seq'`,
        );
        assert.deepStrictEqual(columns, []);
      }

      const staleObjects = yield* sql<{
        readonly name: string;
      }>`
        SELECT name
        FROM sqlite_master
        WHERE name = 'canonical_state_sequence'
           OR name IN ${sql.in(revisionIndexes)}
           OR name LIKE '%_canonical_revision_insert'
           OR name LIKE '%_canonical_revision_update'
      `;
      assert.deepStrictEqual(staleObjects, []);
    }),
  );
});

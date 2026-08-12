import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("100_ReconcileProviderConnectionSchema", (it) => {
  it.effect("restores schema omitted by an earlier recorded migration 098 body", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });
      yield* sql`DROP TABLE provider_connection_operations`;
      yield* sql`DROP TRIGGER thread_runtime_bindings_compatible_update`;
      yield* sql`DROP TRIGGER thread_runtime_bindings_compatible_insert`;
      yield* sql`DROP TRIGGER thread_harness_states_compatible_update`;
      yield* sql`DROP TRIGGER thread_harness_states_compatible_insert`;
      yield* sql`DROP TABLE thread_runtime_bindings`;
      yield* sql`DROP TABLE thread_harness_states`;
      yield* sql.unsafe(`
        CREATE TABLE thread_harness_states (
          thread_id TEXT PRIMARY KEY,
          harness_kind TEXT NOT NULL CHECK (harness_kind IN ('codex', 'claudeAgent', 'opencode')),
          native_state_generation_id TEXT NOT NULL,
          provider_session_id TEXT,
          native_state_locator_json TEXT NOT NULL CHECK (json_valid(native_state_locator_json)),
          last_verified_resume_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
          FOREIGN KEY (native_state_generation_id)
            REFERENCES provider_native_state_generations(native_state_generation_id) ON DELETE RESTRICT
        )
      `);
      yield* sql.unsafe(`
        CREATE TABLE thread_runtime_bindings (
          thread_id TEXT PRIMARY KEY,
          connection_id TEXT,
          installation_id TEXT NOT NULL,
          internal_provider_id TEXT,
          model_id TEXT,
          binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES thread_harness_states(thread_id) ON DELETE CASCADE,
          FOREIGN KEY (connection_id) REFERENCES provider_connections(connection_id) ON DELETE RESTRICT,
          FOREIGN KEY (installation_id) REFERENCES provider_installations(installation_id) ON DELETE RESTRICT
        )
      `);

      const before = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_connection_operations'
      `;
      assert.strictEqual(before[0]?.count, 0);

      const executed = yield* runMigrations({ toMigrationInclusive: 100 });
      assert.deepInclude(executed, [100, "ReconcileProviderConnectionSchema"]);

      const after = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_connection_operations'
      `;
      assert.strictEqual(after[0]?.count, 1);
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(thread_harness_states)`;
      assert.strictEqual(
        columns.some((column) => column.name === "state_revision"),
        true,
      );
      const definitions = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'thread_harness_states'
      `;
      assert.strictEqual(definitions[0]?.sql.includes("harness_kind IN"), false);

      const executedNext = yield* runMigrations({ toMigrationInclusive: 101 });
      assert.deepInclude(executedNext, [101, "ExactProviderNativeStateMigration"]);
    }),
  );
});

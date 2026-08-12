import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("101_ExactProviderNativeStateMigration", (it) => {
  it.effect(
    "migrates only adapter-exact resume identities and removes projection-shaped state",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 100 });
        yield* sql`
        INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES ('migration-space', 'Personal', '', 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at, space_id
        ) VALUES (
          'migration-folder', 'project', 'Folder', NULL, '[]',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 'migration-space'
        )
      `;
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
          created_at, updated_at
        ) VALUES
          ('exact-thread', 'migration-folder', 'Exact', 'full-access', 'default', 'local',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'),
          ('invalid-thread', 'migration-folder', 'Invalid', 'full-access', 'default', 'local',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json
        ) VALUES
          ('exact-thread', 'codex', 'codex', 'stopped',
            '2026-08-08T00:00:00.000Z', '{"threadId":"native-codex-thread","cwd":"/repo"}'),
          ('invalid-thread', 'codex', 'codex', 'stopped',
            '2026-08-08T00:00:00.000Z', '{"providerThreadId":"not-a-resume-cursor"}')
      `;

        yield* runMigrations({ toMigrationInclusive: 101 });
        const rows = yield* sql<{
          readonly thread_id: string;
          readonly provider_session_id: string;
          readonly native_state_locator_json: string;
          readonly adapter_schema_version: string;
          readonly migration_state: string;
        }>`
        SELECT state.thread_id, state.provider_session_id, state.native_state_locator_json,
          generation.adapter_schema_version, migration.migration_state
        FROM thread_harness_states AS state
        JOIN provider_native_state_generations AS generation
          ON generation.native_state_generation_id = state.native_state_generation_id
        JOIN provider_native_state_migrations AS migration
          ON migration.native_state_generation_id = state.native_state_generation_id
        ORDER BY state.thread_id
      `;
        assert.deepStrictEqual(rows, [
          {
            thread_id: "exact-thread",
            provider_session_id: "native-codex-thread",
            native_state_locator_json: '{"threadId":"native-codex-thread","cwd":"/repo"}',
            adapter_schema_version: "legacy-native-state-pending-v1",
            migration_state: "pending",
          },
        ]);
        const bindings = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM thread_runtime_bindings
        `;
        assert.strictEqual(bindings[0]?.count, 0);
      }),
  );
});

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("098 legacy provider state migration", (it) => {
  it.effect("does not infer native state from projection session metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* sql`
        INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES ('legacy-space', 'Personal', '', 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at, space_id
        ) VALUES (
          'legacy-folder', 'project', 'Folder', NULL, '[]',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 'legacy-space'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
          created_at, updated_at
        ) VALUES
          ('legacy-started', 'legacy-folder', 'Started', 'full-access', 'default', 'local',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'),
          ('legacy-unstarted', 'legacy-folder', 'Unstarted', 'full-access', 'default', 'local',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id, provider_thread_id,
          runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES (
          'legacy-started', 'stopped', 'claudeAgent', 'sdk-session-1', 'claude-thread-1',
          'full-access', NULL, NULL, '2026-08-08T00:01:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 98 });
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly harness_kind: string;
        readonly provider_session_id: string | null;
        readonly native_state_locator_json: string;
      }>`
        SELECT thread_id, harness_kind, provider_session_id, native_state_locator_json
        FROM thread_harness_states ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, []);
    }),
  );
});

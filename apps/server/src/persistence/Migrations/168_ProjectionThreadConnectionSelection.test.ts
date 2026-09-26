import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("168_ProjectionThreadConnectionSelection", (it) => {
  it.effect(
    "backfills existing thread Connections from runtime bindings and preserves unset choices",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 167 });
        const timestamp = "2026-09-16T12:00:00.000Z";
        yield* sql`
        INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES ('space-1', 'Space', '', 0, ${timestamp}, ${timestamp})
      `;
        yield* sql`
        INSERT INTO projection_folders (
          folder_id, kind, space_id, title, workspace_root,
          default_model_selection_json, scripts_json, created_at, updated_at
        ) VALUES ('folder-1', 'folder', 'space-1', 'Folder', '/workspace', NULL, '[]', ${timestamp}, ${timestamp})
      `;
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, runtime_mode,
          sidebar_sort_order, created_at, updated_at
        ) VALUES
          ('bound', 'folder-1', 'Bound', '{"provider":"codex","model":"gpt-5.6-sol"}', 'full-access', 0, ${timestamp}, ${timestamp}),
          ('unset', 'folder-1', 'Unset', NULL, 'full-access', 1, ${timestamp}, ${timestamp})
      `;
        yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, profile_ref, provider_identity_id, health_status, lifecycle,
          created_at, updated_at
        ) VALUES ('connection-1', 'codex', 'openai-first-party', 'chatgpt',
          'person@example.com', 'provider-profile:connection-1', 'person@example.com',
          'unknown', 'active', ${timestamp}, ${timestamp})
      `;
        yield* sql`
        INSERT INTO provider_installations (
          installation_id, harness_kind, version, platform, architecture, executable_path,
          artifact_source, artifact_url, artifact_sha256, adapter_version, protocol_version,
          lifecycle, installed_at, activated_at
        ) VALUES ('installation-1', 'codex', '1', 'darwin', 'arm64', '/managed/codex',
          'github-release', 'https://example.invalid/codex', ${"a".repeat(64)}, '1',
          'codex-app-server-v2', 'active', ${timestamp}, ${timestamp})
      `;
        yield* sql`
        INSERT INTO provider_native_state_generations (
          native_state_generation_id, harness_kind, adapter_schema_version,
          state_manifest_json, lifecycle, created_at, owner_thread_id
        ) VALUES ('generation-1', 'codex', '1', '{}', 'active', ${timestamp}, 'bound')
      `;
        yield* sql`
        INSERT INTO thread_harness_states (
          thread_id, harness_kind, native_state_generation_id, provider_session_id,
          native_state_locator_json, created_at, updated_at
        ) VALUES ('bound', 'codex', 'generation-1', NULL, '{}', ${timestamp}, ${timestamp})
      `;
        yield* sql`
        INSERT INTO thread_runtime_bindings (
          thread_id, connection_id, installation_id, binding_revision, created_at, updated_at
        ) VALUES ('bound', 'connection-1', 'installation-1', 0, ${timestamp}, ${timestamp})
      `;

        yield* runMigrations({ toMigrationInclusive: 168 });

        const rows = yield* sql<{
          readonly threadId: string;
          readonly connectionId: string | null;
          readonly selected: number;
        }>`
        SELECT thread_id AS "threadId", connection_id AS "connectionId",
          connection_id_selected AS selected
        FROM projection_threads ORDER BY thread_id
      `;
        assert.deepStrictEqual(rows, [
          { threadId: "bound", connectionId: "connection-1", selected: 1 },
          { threadId: "unset", connectionId: null, selected: 0 },
        ]);

        yield* sql`
        UPDATE projection_threads SET connection_id = NULL, connection_id_selected = 1
        WHERE thread_id = 'bound'
      `;
        yield* runMigrations({ toMigrationInclusive: 168 });
        const [anonymous] = yield* sql<{
          readonly connectionId: string | null;
          readonly selected: number;
        }>`
        SELECT connection_id AS "connectionId", connection_id_selected AS selected
        FROM projection_threads WHERE thread_id = 'bound'
      `;
        assert.deepStrictEqual(anonymous, { connectionId: null, selected: 1 });
      }),
  );
});

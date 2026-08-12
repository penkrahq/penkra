import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("098_ProviderConnectionsAndBindings", (it) => {
  it.effect("enforces harness compatibility and only falls Space defaults forward", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 98 });
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES (
          'space-1', 'Personal', '', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json,
          created_at, updated_at, space_id
        ) VALUES (
          'folder-1', 'project', 'Folder', NULL, '[]',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 'space-1'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'folder-1', 'Thread', 'full-access', 'default', 'local',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_installations (
          installation_id, harness_kind, version, platform, architecture,
          executable_path, artifact_source, artifact_url, artifact_sha256,
          adapter_version, protocol_version, lifecycle, installed_at, activated_at
        ) VALUES
          ('install-codex', 'codex', '0.147.0', 'darwin', 'arm64',
            '/managed/codex', 'github-release', 'https://example.invalid/codex',
            ${"a".repeat(64)}, '1', 'codex-app-server-v2', 'active',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'),
          ('install-claude', 'claudeAgent', '2.1.226', 'darwin', 'arm64',
            '/managed/claude', 'anthropic-release-manifest', 'https://example.invalid/claude',
            ${"b".repeat(64)}, '1', 'claude-agent-sdk-0.3', 'active',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO provider_native_state_generations (
          native_state_generation_id, harness_kind, adapter_schema_version,
          state_manifest_json, lifecycle, created_at
        ) VALUES ('native-1', 'codex', '1', '{}', 'active', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO thread_harness_states (
          thread_id, harness_kind, native_state_generation_id, provider_session_id,
          native_state_locator_json, created_at, updated_at
        ) VALUES (
          'thread-1', 'codex', 'native-1', 'provider-thread-1', '{}',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, profile_ref, lifecycle, created_at, updated_at
        ) VALUES
          ('connection-a', 'codex', 'openai-first-party', 'managed-login',
            'Personal', 'profile-a', 'active',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'),
          ('connection-b', 'codex', 'openai-first-party', 'managed-login',
            'Work', 'profile-b', 'active',
            '2026-08-08T00:00:01.000Z', '2026-08-08T00:00:01.000Z'),
          ('connection-claude', 'claudeAgent', 'anthropic-first-party', 'api-key',
            'Claude', 'profile-claude', 'active',
            '2026-08-08T00:00:02.000Z', '2026-08-08T00:00:02.000Z')
      `;

      const incompatible = yield* Effect.exit(sql`
        INSERT INTO thread_runtime_bindings (
          thread_id, connection_id, installation_id, model_id,
          binding_revision, created_at, updated_at
        ) VALUES (
          'thread-1', 'connection-claude', 'install-codex', 'gpt-5.5', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `);
      assert.isTrue(incompatible._tag === "Failure");

      yield* sql`
        INSERT INTO thread_runtime_bindings (
          thread_id, connection_id, installation_id, model_id,
          binding_revision, created_at, updated_at
        ) VALUES (
          'thread-1', 'connection-b', 'install-codex', 'gpt-5.5', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO space_connection_defaults (
          space_id, harness_kind, connection_id, created_at, updated_at
        ) VALUES (
          'space-1', 'codex', 'connection-b',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        UPDATE provider_connections
        SET lifecycle = 'terminated', termination_reason = 'disconnected',
            terminated_at = '2026-08-08T00:01:00.000Z', updated_at = '2026-08-08T00:01:00.000Z'
        WHERE connection_id = 'connection-b'
      `;

      const defaults = yield* sql<{ readonly connection_id: string }>`
        SELECT connection_id FROM space_connection_defaults
      `;
      assert.deepStrictEqual(defaults, [{ connection_id: "connection-a" }]);
      const bindings = yield* sql<{ readonly connection_id: string }>`
        SELECT connection_id FROM thread_runtime_bindings
      `;
      assert.deepStrictEqual(bindings, [{ connection_id: "connection-b" }]);
    }),
  );
});

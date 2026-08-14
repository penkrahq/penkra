import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("118_CanonicalProviderConnectionIdentities", (it) => {
  it.effect("moves pre-fix threads to the active record for the same verified identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 117 });

      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES ('identity-space', 'Identity', '', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at, space_id
        ) VALUES ('identity-project', 'project', 'Identity', NULL, '[]',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 'identity-space')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, env_mode, created_at, updated_at
        ) VALUES ('identity-thread', 'identity-project', 'Identity', 'full-access', 'local',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, profile_ref, provider_identity_id, health_status, lifecycle,
          termination_reason, terminated_at, created_at, updated_at
        ) VALUES ('connection-old', 'codex', 'openai-first-party', 'chatgpt',
          'person@example.com', 'provider-profile:connection-old', 'person@example.com',
          'unknown', 'active', NULL, NULL,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO provider_installations (
          installation_id, harness_kind, version, platform, architecture, executable_path,
          artifact_source, artifact_url, artifact_sha256, adapter_version, protocol_version,
          lifecycle, installed_at, activated_at
        ) VALUES ('identity-installation', 'codex', '1', 'darwin', 'arm64', '/managed/codex',
          'github-release', 'https://example.invalid/codex', ${"a".repeat(64)}, '1',
          'codex-app-server-v2', 'active', '2026-08-08T00:00:00.000Z',
          '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO provider_native_state_generations (
          native_state_generation_id, harness_kind, adapter_schema_version,
          state_manifest_json, lifecycle, created_at, owner_thread_id
        ) VALUES ('identity-generation', 'codex', '1', '{}', 'active',
          '2026-08-08T00:00:00.000Z', 'identity-thread')
      `;
      yield* sql`
        INSERT INTO thread_harness_states (
          thread_id, harness_kind, native_state_generation_id, provider_session_id,
          native_state_locator_json, created_at, updated_at
        ) VALUES ('identity-thread', 'codex', 'identity-generation', NULL, '{}',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO thread_runtime_bindings (
          thread_id, connection_id, installation_id, binding_revision, created_at, updated_at
        ) VALUES ('identity-thread', 'connection-old', 'identity-installation', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        UPDATE provider_connections
        SET lifecycle = 'terminated', termination_reason = 'signed-out',
            terminated_at = '2026-08-08T00:01:00.000Z', health_status = 'unavailable',
            updated_at = '2026-08-08T00:01:00.000Z'
        WHERE connection_id = 'connection-old'
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, profile_ref, provider_identity_id, health_status, lifecycle,
          created_at, updated_at
        ) VALUES ('connection-active', 'codex', 'openai-first-party', 'chatgpt',
          'person@example.com', 'provider-profile:connection-active', 'person@example.com',
          'unknown', 'active', '2026-08-08T00:02:00.000Z', '2026-08-08T00:02:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 118 });

      const bindings = yield* sql<{
        readonly connectionId: string;
        readonly revision: number;
      }>`
        SELECT connection_id AS "connectionId", binding_revision AS revision
        FROM thread_runtime_bindings WHERE thread_id = 'identity-thread'
      `;
      assert.deepStrictEqual(bindings, [{ connectionId: "connection-active", revision: 1 }]);

      const connections = yield* sql<{
        readonly id: string;
        readonly identity: string;
        readonly lifecycle: string;
      }>`
        SELECT connection_id AS id, provider_identity_id AS identity, lifecycle
        FROM provider_connections ORDER BY connection_id
      `;
      assert.deepStrictEqual(connections, [
        {
          id: "connection-active",
          identity: "person@example.com",
          lifecycle: "active",
        },
        {
          id: "connection-old",
          identity: "superseded:connection-active:connection-old",
          lifecycle: "terminated",
        },
      ]);

      const duplicateInsert = yield* Effect.exit(sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, profile_ref, provider_identity_id, lifecycle, created_at, updated_at
        ) VALUES ('connection-forbidden', 'codex', 'openai-first-party', 'chatgpt',
          'person@example.com', 'provider-profile:connection-forbidden', 'person@example.com',
          'active', '2026-08-08T00:03:00.000Z', '2026-08-08T00:03:00.000Z')
      `);
      assert.strictEqual(duplicateInsert._tag, "Failure");
    }),
  );
});

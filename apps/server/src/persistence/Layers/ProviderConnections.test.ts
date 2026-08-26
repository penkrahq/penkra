import { ProviderConnectionId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProviderConnectionRepository } from "../Services/ProviderConnections.ts";
import { ProviderConnectionRepositoryLive } from "./ProviderConnections.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(sqlLayer, ProviderConnectionRepositoryLive.pipe(Layer.provide(sqlLayer))),
);

layer("ProviderConnectionRepository", (it) => {
  it.effect("queues retired and terminal staging profiles for durable cleanup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProviderConnectionRepository;
      yield* runMigrations();
      yield* sql`
        INSERT INTO provider_connection_logins (
          operation_id, connection_id, committed_connection_id, harness_kind,
          authentication_target_id, authentication_method_id, label, profile_ref,
          provider_login_id, operation_state, provider_identity_id, failure_reason,
          created_at, updated_at
        ) VALUES
          ('failed-login', 'failed-connection', NULL, 'codex', 'openai-first-party',
            'chatgpt', 'Failed', 'provider-profile:failed', NULL, 'failed', NULL,
            'Provider stopped', '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:02:00.000Z'),
          ('open-login', 'open-connection', NULL, 'codex', 'openai-first-party',
            'chatgpt', 'Open', 'provider-profile:open', NULL, 'awaiting-user', NULL,
            NULL, '2026-08-08T00:00:00.000Z', '2026-08-08T00:03:00.000Z')
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id,
          authentication_method_id, label, credential_ref, profile_ref,
          provider_identity_id, health_status, lifecycle, termination_reason,
          terminated_at, created_at, updated_at
        ) VALUES (
          'terminated-connection', 'codex', 'openai-first-party', 'chatgpt',
          'Terminated', NULL, 'provider-profile:terminated-active',
          'terminated@example.test', 'unavailable', 'terminated', 'disconnected',
          '2026-08-08T00:01:00.000Z', '2026-08-08T00:00:00.000Z',
          '2026-08-08T00:01:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_credential_profiles (
          profile_ref, harness_kind, authentication_target_id, authentication_method_id,
          lifecycle, connection_id, login_operation_id, created_at, updated_at, retired_at
        ) VALUES
          ('provider-profile:retired', 'codex', 'openai-first-party', 'chatgpt',
            'retired', NULL, NULL, '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:01:00.000Z', '2026-08-08T00:01:00.000Z'),
          ('provider-profile:failed', 'codex', 'openai-first-party', 'chatgpt',
            'staging', NULL, 'failed-login', '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:02:00.000Z', NULL),
          ('provider-profile:open', 'codex', 'openai-first-party', 'chatgpt',
            'staging', NULL, 'open-login', '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:03:00.000Z', NULL),
          ('provider-profile:terminated-active', 'codex', 'openai-first-party', 'chatgpt',
            'active', 'terminated-connection', NULL, '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:01:00.000Z', NULL)
      `;

      assert.deepStrictEqual(
        (yield* repository.listManagedProfilesPendingCleanup()).map((profile) => ({
          profileRef: profile.profileRef,
          lifecycle: profile.lifecycle,
        })),
        [
          { profileRef: "provider-profile:retired", lifecycle: "retired" },
          { profileRef: "provider-profile:terminated-active", lifecycle: "active" },
          { profileRef: "provider-profile:failed", lifecycle: "staging" },
        ],
      );
    }),
  );

  it.effect("reactivates the canonical identity and absorbs superseded records", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProviderConnectionRepository;
      yield* runMigrations();
      const historicalId = ProviderConnectionId.makeUnsafe("connection-historical");
      const duplicateId = ProviderConnectionId.makeUnsafe("connection-duplicate");
      yield* repository.create({
        id: historicalId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "person@example.com",
        credentialRef: null,
        profileRef: `provider-profile:${historicalId}`,
        providerIdentityId: "person@example.com",
        createdAt: "2026-08-08T00:00:00.000Z",
      });
      yield* repository.terminate({
        id: historicalId,
        reason: "disconnected",
        terminatedAt: "2026-08-08T00:01:00.000Z",
      });
      yield* repository.create({
        id: duplicateId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "person@example.com",
        credentialRef: null,
        profileRef: `provider-profile:${duplicateId}`,
        providerIdentityId: `superseded:${historicalId}:${duplicateId}`,
        createdAt: "2026-08-08T00:02:00.000Z",
      });
      yield* sql`
        INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES ('identity-space', 'Identity', '', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, kind, title, workspace_root, scripts_json, created_at, updated_at, space_id
        ) VALUES ('identity-project', 'project', 'Identity', NULL, '[]',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 'identity-space')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, runtime_mode,
          created_at, updated_at
        ) VALUES ('identity-thread', 'identity-project', 'Identity', 'full-access',
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
        ) VALUES ('identity-thread', ${duplicateId}, 'identity-installation', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      const reactivated = yield* repository.reactivateIdentity({
        id: historicalId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "person@example.com",
        credentialRef: null,
        profileRef: `provider-profile:${historicalId}`,
        providerIdentityId: "person@example.com",
        updatedAt: "2026-08-08T00:03:00.000Z",
      });

      assert.strictEqual(Option.getOrThrow(reactivated).id, historicalId);
      assert.strictEqual(Option.getOrThrow(reactivated).lifecycle, "active");
      const duplicate = Option.getOrThrow(yield* repository.getRecord(duplicateId));
      assert.strictEqual(duplicate.lifecycle, "terminated");
      assert.strictEqual(duplicate.providerIdentityId, `superseded:${historicalId}:${duplicateId}`);
      const bindings = yield* sql<{
        readonly connectionId: string;
        readonly bindingRevision: number;
      }>`
        SELECT connection_id AS "connectionId", binding_revision AS "bindingRevision"
        FROM thread_runtime_bindings WHERE thread_id = 'identity-thread'
      `;
      assert.deepStrictEqual(bindings, [{ connectionId: historicalId, bindingRevision: 1 }]);
      assert.deepStrictEqual(
        (yield* repository.list()).map((connection) => connection.id),
        [historicalId],
      );
      const pathStableId = ProviderConnectionId.makeUnsafe("connection-path-stable");
      yield* sql`
        INSERT INTO provider_credential_profiles (
          profile_ref, harness_kind, authentication_target_id, authentication_method_id,
          lifecycle, connection_id, login_operation_id, created_at, updated_at, retired_at
        ) VALUES
          (${`provider-profile:${historicalId}`}, 'codex', 'openai-first-party', 'chatgpt',
            'active', ${historicalId}, NULL, '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:03:00.000Z', NULL),
          (${`provider-profile:${pathStableId}`}, 'codex', 'openai-first-party', 'chatgpt',
            'staging', NULL, 'login-path-stable', '2026-08-08T00:05:00.000Z',
            '2026-08-08T00:05:00.000Z', NULL)
      `;
      const pathStable = yield* repository.commitManagedProfile({
        id: pathStableId,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "person@example.com",
        credentialRef: null,
        profileRef: `provider-profile:${pathStableId}`,
        providerIdentityId: "person@example.com",
        createdAt: "2026-08-08T00:05:00.000Z",
        updatedAt: "2026-08-08T00:05:00.000Z",
      });
      assert.strictEqual(Option.getOrThrow(pathStable).connection.id, historicalId);
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getRecord(historicalId)).profileRef,
        `provider-profile:${pathStableId}`,
      );
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getRecord(historicalId)).lifecycle,
        "active",
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly connectionId: string; readonly bindingRevision: number }>`
          SELECT connection_id AS "connectionId", binding_revision AS "bindingRevision"
          FROM thread_runtime_bindings WHERE thread_id = 'identity-thread'
        `,
        [{ connectionId: historicalId, bindingRevision: 1 }],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly profileRef: string; readonly lifecycle: string }>`
          SELECT profile_ref AS "profileRef", lifecycle
          FROM provider_credential_profiles
          WHERE profile_ref IN (
            ${`provider-profile:${historicalId}`}, ${`provider-profile:${pathStableId}`}
          )
          ORDER BY profile_ref
        `,
        [
          { profileRef: `provider-profile:${historicalId}`, lifecycle: "retired" },
          { profileRef: `provider-profile:${pathStableId}`, lifecycle: "active" },
        ],
      );
      yield* repository.terminate({
        id: historicalId,
        reason: "removed",
        terminatedAt: "2026-08-08T00:06:00.000Z",
      });
    }),
  );

  it.effect("keeps secret references internal and filters terminated Connections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProviderConnectionRepository;
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES ('space-1', 'Personal', '', 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      const personal = yield* repository.create({
        id: ProviderConnectionId.makeUnsafe("connection-personal"),
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "managed-login",
        label: "Personal",
        credentialRef: null,
        profileRef: "profile-personal",
        providerIdentityId: "account-personal",
        createdAt: "2026-08-08T00:00:00.000Z",
      });
      const work = yield* repository.create({
        id: ProviderConnectionId.makeUnsafe("connection-work"),
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "managed-login",
        label: "Work",
        credentialRef: null,
        profileRef: "profile-work",
        providerIdentityId: "account-work",
        createdAt: "2026-08-08T00:00:01.000Z",
      });

      assert.notProperty(personal, "profileRef");
      assert.notProperty(personal, "credentialRef");
      const terminated = yield* repository.terminate({
        id: work.id,
        reason: "disconnected",
        terminatedAt: "2026-08-08T00:01:00.000Z",
      });
      assert.isTrue(Option.isSome(terminated));
      assert.strictEqual(Option.getOrThrow(terminated).lifecycle, "terminated");
      const active = yield* repository.list();
      assert.deepStrictEqual(
        active.map((connection) => connection.id),
        [personal.id],
      );
      const all = yield* repository.list({ includeTerminated: true });
      assert.deepStrictEqual(
        all.map((connection) => connection.id).filter((id) => id === work.id || id === personal.id),
        [work.id, personal.id],
      );
    }),
  );
});

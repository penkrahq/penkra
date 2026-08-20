import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ThreadProviderBindingRepository } from "../Services/ThreadProviderBindings.ts";
import { ThreadProviderBindingRepositoryLive } from "./ThreadProviderBindings.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(sqlLayer, ThreadProviderBindingRepositoryLive.pipe(Layer.provide(sqlLayer))),
);

layer("ThreadProviderBindingRepository", (it) => {
  it.effect("binds one immutable harness and advances native and runtime revisions exactly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES ('binding-space', 'Personal', '', 0, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at, space_id
        ) VALUES (
          'binding-folder', 'project', 'Folder', NULL, '[]',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', 'binding-space'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'binding-thread', 'binding-folder', 'Thread', 'full-access',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_installations (
          installation_id, harness_kind, version, platform, architecture,
          executable_path, artifact_source, artifact_url, artifact_sha256,
          adapter_version, protocol_version, lifecycle, installed_at, activated_at
        ) VALUES (
          'binding-install', 'codex', '1.0.0', 'darwin', 'arm64', '/managed/codex',
          'test', 'https://example.invalid/codex', ${"a".repeat(64)}, '1', 'v1', 'active',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, profile_ref, lifecycle, created_at, updated_at
        ) VALUES (
          'binding-connection', 'codex', 'openai', 'managed-login', 'Personal',
          'profile-binding', 'active', '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      const repository = yield* ThreadProviderBindingRepository;
      yield* repository.createNativeStateGeneration({
        id: ProviderNativeStateGenerationId.makeUnsafe("native-a"),
        ownerThreadId: ThreadId.makeUnsafe("binding-thread"),
        harness: "codex",
        adapterSchemaVersion: "1",
        stateManifestJson: '{"profile":"profile-binding"}',
        createdAt: "2026-08-08T00:00:00.000Z",
      });
      yield* repository.bindThread({
        threadId: ThreadId.makeUnsafe("binding-thread"),
        harness: "codex",
        nativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe("native-a"),
        providerSessionId: "session-a",
        nativeStateLocatorJson: '{"thread":"native-thread-a"}',
        connectionId: ProviderConnectionId.makeUnsafe("binding-connection"),
        installationId: ProviderInstallationId.makeUnsafe("binding-install"),
        internalProviderId: null,
        modelId: "gpt-5.5",
        createdAt: "2026-08-08T00:00:00.000Z",
      });
      yield* repository.createNativeStateGeneration({
        id: ProviderNativeStateGenerationId.makeUnsafe("native-b"),
        ownerThreadId: ThreadId.makeUnsafe("binding-thread"),
        harness: "codex",
        adapterSchemaVersion: "1",
        stateManifestJson: '{"profile":"profile-binding"}',
        createdAt: "2026-08-08T00:01:00.000Z",
      });

      const state = Option.getOrThrow(
        yield* repository.replaceNativeState({
          threadId: ThreadId.makeUnsafe("binding-thread"),
          expectedRevision: 0,
          nativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe("native-b"),
          providerSessionId: "session-b",
          nativeStateLocatorJson: '{"thread":"native-thread-b"}',
          verifiedAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:01:00.000Z",
        }),
      );
      assert.strictEqual(state.revision, 1);
      assert.strictEqual(
        Option.isNone(
          yield* repository.replaceNativeState({
            threadId: ThreadId.makeUnsafe("binding-thread"),
            expectedRevision: 0,
            nativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe("native-a"),
            providerSessionId: "stale",
            nativeStateLocatorJson: "{}",
            verifiedAt: null,
            updatedAt: "2026-08-08T00:02:00.000Z",
          }),
        ),
        true,
      );
      const binding = Option.getOrThrow(
        yield* repository.updateRuntimeBinding({
          threadId: ThreadId.makeUnsafe("binding-thread"),
          expectedRevision: 0,
          connectionId: ProviderConnectionId.makeUnsafe("binding-connection"),
          installationId: ProviderInstallationId.makeUnsafe("binding-install"),
          internalProviderId: null,
          modelId: "gpt-5.6",
          updatedAt: "2026-08-08T00:01:00.000Z",
        }),
      );
      assert.strictEqual(binding.revision, 1);
      assert.strictEqual(binding.modelId, "gpt-5.6");

      const conflicted = yield* Effect.exit(
        repository.commitSwitch({
          threadId: ThreadId.makeUnsafe("binding-thread"),
          expectedStateRevision: 1,
          expectedBindingRevision: 0,
          generation: {
            id: ProviderNativeStateGenerationId.makeUnsafe("native-c-conflict"),
            ownerThreadId: ThreadId.makeUnsafe("binding-thread"),
            harness: "codex",
            adapterSchemaVersion: "1",
            stateManifestJson: '{"profile":"profile-next"}',
            createdAt: "2026-08-08T00:02:00.000Z",
          },
          providerSessionId: "session-c",
          nativeStateLocatorJson: '{"thread":"native-thread-c"}',
          verifiedAt: "2026-08-08T00:02:00.000Z",
          connectionId: ProviderConnectionId.makeUnsafe("binding-connection"),
          installationId: ProviderInstallationId.makeUnsafe("binding-install"),
          internalProviderId: null,
          modelId: "gpt-5.6",
          updatedAt: "2026-08-08T00:02:00.000Z",
        }),
      );
      assert.strictEqual(conflicted._tag, "Failure");
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getHarnessState(ThreadId.makeUnsafe("binding-thread")))
          .nativeStateGenerationId,
        "native-b",
      );
      const rolledBack = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM provider_native_state_generations
        WHERE native_state_generation_id = 'native-c-conflict'
      `;
      assert.deepStrictEqual(rolledBack, [{ count: 0 }]);

      const outerTransactionFailure = yield* Effect.exit(
        sql.withTransaction(
          repository
            .commitSwitchInCurrentTransaction({
              threadId: ThreadId.makeUnsafe("binding-thread"),
              expectedStateRevision: 1,
              expectedBindingRevision: 1,
              generation: {
                id: ProviderNativeStateGenerationId.makeUnsafe("native-outer-rollback"),
                ownerThreadId: ThreadId.makeUnsafe("binding-thread"),
                harness: "codex",
                adapterSchemaVersion: "1",
                stateManifestJson: '{"profile":"profile-next"}',
                createdAt: "2026-08-08T00:02:30.000Z",
              },
              providerSessionId: "session-outer-rollback",
              nativeStateLocatorJson: '{"thread":"native-thread-outer-rollback"}',
              verifiedAt: "2026-08-08T00:02:30.000Z",
              connectionId: ProviderConnectionId.makeUnsafe("binding-connection"),
              installationId: ProviderInstallationId.makeUnsafe("binding-install"),
              internalProviderId: null,
              modelId: "gpt-5.6",
              updatedAt: "2026-08-08T00:02:30.000Z",
            })
            .pipe(Effect.andThen(Effect.fail(new Error("later orchestration write failed")))),
        ),
      );
      assert.strictEqual(outerTransactionFailure._tag, "Failure");
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getHarnessState(ThreadId.makeUnsafe("binding-thread")))
          .nativeStateGenerationId,
        "native-b",
      );
      const outerRolledBack = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM provider_native_state_generations
        WHERE native_state_generation_id = 'native-outer-rollback'
      `;
      assert.deepStrictEqual(outerRolledBack, [{ count: 0 }]);

      yield* sql`
        UPDATE provider_installations
        SET lifecycle = 'retired', retired_at = '2026-08-08T00:03:00.000Z'
        WHERE installation_id = 'binding-install'
      `;

      const switched = yield* repository.commitSwitch({
        threadId: ThreadId.makeUnsafe("binding-thread"),
        expectedStateRevision: 1,
        expectedBindingRevision: 1,
        generation: {
          id: ProviderNativeStateGenerationId.makeUnsafe("native-c"),
          ownerThreadId: ThreadId.makeUnsafe("binding-thread"),
          harness: "codex",
          adapterSchemaVersion: "1",
          stateManifestJson: '{"profile":"profile-next"}',
          createdAt: "2026-08-08T00:03:00.000Z",
        },
        providerSessionId: "session-c",
        nativeStateLocatorJson: '{"thread":"native-thread-c"}',
        verifiedAt: "2026-08-08T00:03:00.000Z",
        connectionId: ProviderConnectionId.makeUnsafe("binding-connection"),
        installationId: ProviderInstallationId.makeUnsafe("binding-install"),
        internalProviderId: null,
        modelId: "gpt-5.6",
        updatedAt: "2026-08-08T00:03:00.000Z",
      });
      assert.strictEqual(switched.state.revision, 2);
      assert.strictEqual(switched.binding.revision, 2);
    }),
  );
});

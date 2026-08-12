import { ProviderNativeStateGenerationId, ThreadId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProviderNativeStateDeletionRepositoryLive } from "../Layers/ProviderNativeStateDeletions.ts";
import { ProviderNativeStateDeletionRepository } from "../Services/ProviderNativeStateDeletions.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(sqlLayer, ProviderNativeStateDeletionRepositoryLive.pipe(Layer.provide(sqlLayer))),
);

layer("104_ProviderNativeStateOwnership", (it) => {
  it.effect("queues every generation owned by a permanently deleted thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const timestamp = "2026-08-08T00:00:00.000Z";
      yield* runMigrations({ toMigrationInclusive: 103 });
      // Reproduce the exact on-machine v101 lineage that recorded migration
      // 101 before its durable migration journal existed.
      yield* sql.unsafe(
        `DROP TRIGGER IF EXISTS provider_native_state_migrations_immutable_identity`,
      );
      yield* sql.unsafe(`DROP TABLE IF EXISTS provider_native_state_migrations`);
      yield* sql`
        INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES ('cleanup-space', 'Personal', '', 0, ${timestamp}, ${timestamp})
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at, space_id
        ) VALUES ('cleanup-folder', 'project', 'Folder', NULL, '[]', ${timestamp}, ${timestamp}, 'cleanup-space')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
          created_at, updated_at
        ) VALUES (
          'cleanup-thread', 'cleanup-folder', 'Thread', 'full-access', 'default', 'local',
          ${timestamp}, ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO provider_native_state_generations (
          native_state_generation_id, harness_kind, adapter_schema_version,
          state_manifest_json, lifecycle, created_at
        ) VALUES
          ('cleanup-current', 'codex', 'managed-native-state-v1',
            '{"sourceGenerationId":"cleanup-retained"}', 'active', ${timestamp}),
          ('cleanup-retained', 'codex', 'managed-native-state-v1', '{}', 'retained', ${timestamp})
      `;
      yield* sql`
        INSERT INTO thread_harness_states (
          thread_id, harness_kind, native_state_generation_id, provider_session_id,
          native_state_locator_json, state_revision, created_at, updated_at
        ) VALUES (
          'cleanup-thread', 'codex', 'cleanup-current', 'native-session',
          '{"threadId":"native-session"}', 0, ${timestamp}, ${timestamp}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 104 });
      const migrationJournal = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_native_state_migrations'
      `;
      assert.deepStrictEqual(migrationJournal, [{ name: "provider_native_state_migrations" }]);
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'cleanup-thread'`;

      const rows = yield* sql<{
        readonly generationId: string;
        readonly ownerThreadId: string;
        readonly state: string;
      }>`
        SELECT native_state_generation_id AS "generationId",
          owner_thread_id AS "ownerThreadId", deletion_state AS state
        FROM provider_native_state_deletions
        ORDER BY native_state_generation_id
      `;
      assert.deepStrictEqual(rows, [
        { generationId: "cleanup-current", ownerThreadId: "cleanup-thread", state: "pending" },
        { generationId: "cleanup-retained", ownerThreadId: "cleanup-thread", state: "pending" },
      ]);

      const deletions = yield* ProviderNativeStateDeletionRepository;
      for (const generationId of ["cleanup-current", "cleanup-retained"] as const) {
        const id = ProviderNativeStateGenerationId.makeUnsafe(generationId);
        yield* deletions.markDeleting(id);
        yield* deletions.finalize({
          generationId: id,
          ownerThreadId: ThreadId.makeUnsafe("cleanup-thread"),
        });
      }
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM provider_native_state_generations
        WHERE owner_thread_id = 'cleanup-thread'
      `;
      assert.deepStrictEqual(remaining, [{ count: 0 }]);
    }),
  );
});

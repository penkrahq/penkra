import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyLayer("109_ProviderRuntimeBindingSwitchOperations legacy lineage", (it) => {
  it.effect("upgrades the recorded v99 schema that predates nullable result fields", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* sql.unsafe(
        `DROP TRIGGER IF EXISTS provider_thread_switch_operations_valid_transition`,
      );
      yield* sql.unsafe(`ALTER TABLE provider_thread_switch_operations DROP COLUMN cwd`);
      yield* sql.unsafe(
        `ALTER TABLE provider_thread_switch_operations DROP COLUMN verification_json`,
      );
      yield* sql`
        INSERT INTO provider_thread_switch_operations (
          operation_id, thread_id, command_id, operation_state,
          source_state_revision, source_binding_revision, target_native_state_generation_id,
          selection_json, command_json, failure_reason, created_at, updated_at
        ) VALUES (
          'legacy-operation', 'thread-1', 'command-1', 'committed',
          1, 1, 'generation-1', '{}', '{}', NULL,
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 109 });

      const rows = yield* sql<{ readonly id: string; readonly cwd: string | null }>`
        SELECT operation_id AS id, cwd
        FROM provider_thread_switch_operations
      `;
      assert.deepStrictEqual(rows, [{ id: "legacy-operation", cwd: null }]);
    }),
  );
});

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("109_ProviderRuntimeBindingSwitchOperations", (it) => {
  it.effect("preserves native switches and accepts repeated model-only changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* sql`
        INSERT INTO provider_thread_switch_operations (
          operation_id, thread_id, command_id, operation_state,
          source_state_revision, source_binding_revision, target_native_state_generation_id,
          selection_json, command_json, cwd, verification_json, failure_reason, created_at, updated_at
        ) VALUES (
          'native-operation', 'thread-1', 'command-1', 'committed',
          1, 1, 'generation-1', '{}', '{}', NULL, '{}', NULL,
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 109 });
      yield* sql`
        INSERT INTO provider_thread_switch_operations (
          operation_id, thread_id, command_id, operation_kind, operation_state,
          source_state_revision, source_binding_revision, target_native_state_generation_id,
          selection_json, command_json, cwd, verification_json, failure_reason, created_at, updated_at
        ) VALUES
          ('model-operation-1', 'thread-1', 'command-2', 'runtime-binding', 'committed',
           1, 2, NULL, '{}', '{}', NULL, NULL, NULL,
           '2026-08-10T00:01:00.000Z', '2026-08-10T00:01:00.000Z'),
          ('model-operation-2', 'thread-1', 'command-3', 'runtime-binding', 'committed',
           1, 3, NULL, '{}', '{}', NULL, NULL, NULL,
           '2026-08-10T00:02:00.000Z', '2026-08-10T00:02:00.000Z')
      `;

      const rows = yield* sql<{
        readonly id: string;
        readonly kind: string;
        readonly generationId: string | null;
      }>`
        SELECT operation_id AS id, operation_kind AS kind,
               target_native_state_generation_id AS "generationId"
        FROM provider_thread_switch_operations
        ORDER BY created_at
      `;
      assert.deepStrictEqual(rows, [
        { id: "native-operation", kind: "native-state", generationId: "generation-1" },
        { id: "model-operation-1", kind: "runtime-binding", generationId: null },
        { id: "model-operation-2", kind: "runtime-binding", generationId: null },
      ]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("172_ProviderSwitchFailureCleanup", (it) => {
  it.effect("preserves old journals and requires cleanup before terminal failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 170 });
      yield* sql`
        INSERT INTO provider_thread_switch_operations (
          operation_id, thread_id, command_id, operation_kind, operation_state,
          source_state_revision, source_binding_revision, target_native_state_generation_id,
          selection_json, command_json, cwd, verification_json, failure_reason, created_at, updated_at
        ) VALUES (
          'switch-cleanup', 'thread-cleanup', 'command-cleanup', 'native-state', 'pending',
          4, 2, 'generation-cleanup', '{}', '{}', NULL, NULL, NULL,
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;
      // This branch intentionally has no migration 171. The diagnostics
      // lineage supplies it when both branches are integrated.
      yield* runMigrations({ toMigrationInclusive: 171 });
      const skipped = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS id FROM effect_sql_migrations WHERE migration_id > 170
      `;
      assert.deepStrictEqual(skipped, []);
      yield* runMigrations({ toMigrationInclusive: 172 });
      yield* sql`
        UPDATE provider_thread_switch_operations
        SET operation_state = 'failed-cleanup-pending', failure_reason = 'Verification failed.',
            updated_at = '2026-08-10T00:00:01.000Z'
        WHERE operation_id = 'switch-cleanup'
      `;
      const rows = yield* sql<{ readonly state: string; readonly reason: string }>`
        SELECT operation_state AS state, failure_reason AS reason
        FROM provider_thread_switch_operations WHERE operation_id = 'switch-cleanup'
      `;
      assert.deepStrictEqual(rows, [
        { state: "failed-cleanup-pending", reason: "Verification failed." },
      ]);
      assert.strictEqual(
        (yield* Effect.exit(sql`
          UPDATE provider_thread_switch_operations
          SET operation_state = 'committed' WHERE operation_id = 'switch-cleanup'
        `))._tag,
        "Failure",
      );
      yield* sql`
        UPDATE provider_thread_switch_operations
        SET operation_state = 'failed' WHERE operation_id = 'switch-cleanup'
      `;
    }),
  );
});

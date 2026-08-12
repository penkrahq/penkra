import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("110_SettleProviderSwitchSource", (it) => {
  it.effect("pins a pending journal to its settled exact source only once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 110 });
      yield* sql`
        INSERT INTO provider_thread_switch_operations (
          operation_id, thread_id, command_id, operation_kind, operation_state,
          source_state_revision, source_binding_revision, target_native_state_generation_id,
          selection_json, command_json, cwd, verification_json, failure_reason, created_at, updated_at
        ) VALUES (
          'switch-1', 'thread-1', 'command-1', 'native-state', 'pending',
          4, 2, 'generation-1', '{"stateRevision":4}', '{}', NULL, NULL, NULL,
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;
      yield* sql`
        UPDATE provider_thread_switch_operations
        SET operation_state = 'interrupted', source_state_revision = 5,
            selection_json = '{"stateRevision":5}', updated_at = '2026-08-10T00:00:01.000Z'
        WHERE operation_id = 'switch-1'
      `;
      const rows = yield* sql<{ readonly state: string; readonly revision: number }>`
        SELECT operation_state AS state, source_state_revision AS revision
        FROM provider_thread_switch_operations WHERE operation_id = 'switch-1'
      `;
      assert.deepStrictEqual(rows, [{ state: "interrupted", revision: 5 }]);
      assert.strictEqual(
        (yield* Effect.exit(sql`
          UPDATE provider_thread_switch_operations
          SET source_state_revision = 6, updated_at = '2026-08-10T00:00:02.000Z'
          WHERE operation_id = 'switch-1'
        `))._tag,
        "Failure",
      );
    }),
  );
});

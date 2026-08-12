import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("099_ProviderThreadSwitchOperations", (it) => {
  it.effect("permits only one open operation per thread and forward-only transitions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });
      const insert = (operationId: string, commandId: string) => sql`
        INSERT INTO provider_thread_switch_operations (
          operation_id, thread_id, command_id, operation_state,
          source_state_revision, source_binding_revision,
          target_native_state_generation_id, selection_json, command_json,
          verification_json, failure_reason, created_at, updated_at
        ) VALUES (
          ${operationId}, 'thread-1', ${commandId}, 'pending', 2, 3,
          ${`generation-${operationId}`}, '{}', '{}', NULL, NULL,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;

      yield* insert("switch-1", "command-1");
      assert.isTrue((yield* Effect.exit(insert("switch-2", "command-2")))._tag === "Failure");
      assert.isTrue(
        (yield* Effect.exit(sql`
            UPDATE provider_thread_switch_operations
            SET operation_state = 'verified', updated_at = '2026-08-08T00:00:01.000Z'
            WHERE operation_id = 'switch-1'
          `))._tag === "Failure",
      );
      yield* sql`
        UPDATE provider_thread_switch_operations
        SET operation_state = 'interrupted', updated_at = '2026-08-08T00:00:01.000Z'
        WHERE operation_id = 'switch-1'
      `;
      yield* sql`
        UPDATE provider_thread_switch_operations
        SET operation_state = 'verified', updated_at = '2026-08-08T00:00:02.000Z'
        WHERE operation_id = 'switch-1'
      `;
      yield* sql`
        UPDATE provider_thread_switch_operations
        SET operation_state = 'committed', updated_at = '2026-08-08T00:00:03.000Z'
        WHERE operation_id = 'switch-1'
      `;
      yield* insert("switch-2", "command-2");
    }),
  );
});

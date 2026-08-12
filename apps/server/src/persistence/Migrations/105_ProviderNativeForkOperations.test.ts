import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("105_ProviderNativeForkOperations", (it) => {
  it.effect("enforces one open fork per target and forward-only transitions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 105 });
      const insert = (operationId: string, commandId: string, generationId: string) => sql`
        INSERT INTO provider_native_fork_operations (
          operation_id, command_id, source_thread_id, target_thread_id, operation_state,
          source_state_revision, source_binding_revision, target_native_state_generation_id,
          selection_json, command_json, fork_result_json, failure_reason, created_at, updated_at
        ) VALUES (
          ${operationId}, ${commandId}, 'source-thread', 'target-thread', 'pending',
          2, 3, ${generationId}, '{}', '{}', NULL, NULL,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;

      yield* insert("fork-1", "command-1", "generation-1");
      assert.isTrue(
        (yield* Effect.exit(insert("fork-2", "command-2", "generation-2")))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.exit(sql`
          UPDATE provider_native_fork_operations
          SET operation_state = 'forked', updated_at = '2026-08-08T00:00:01.000Z'
          WHERE operation_id = 'fork-1'
        `))._tag === "Failure",
      );
      yield* sql`
        UPDATE provider_native_fork_operations
        SET operation_state = 'materialized', updated_at = '2026-08-08T00:00:01.000Z'
        WHERE operation_id = 'fork-1'
      `;
      yield* sql`
        UPDATE provider_native_fork_operations
        SET operation_state = 'forked', fork_result_json = '{}',
          updated_at = '2026-08-08T00:00:02.000Z'
        WHERE operation_id = 'fork-1'
      `;
      yield* sql`
        UPDATE provider_native_fork_operations
        SET operation_state = 'failed', failure_reason = 'dispatch failed',
          updated_at = '2026-08-08T00:00:03.000Z'
        WHERE operation_id = 'fork-1'
      `;
      yield* insert("fork-2", "command-2", "generation-2");
    }),
  );
});

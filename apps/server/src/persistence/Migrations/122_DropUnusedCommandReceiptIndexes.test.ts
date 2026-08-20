import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("122_DropUnusedCommandReceiptIndexes", (it) => {
  it.effect("drops secondary indexes while preserving command-id deduplication", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 121 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_command_receipts'
      `;
      assert.include(
        before.map(({ name }) => name),
        "idx_orch_command_receipts_aggregate",
      );
      assert.include(
        before.map(({ name }) => name),
        "idx_orch_command_receipts_sequence",
      );

      const executed = yield* runMigrations({ toMigrationInclusive: 122 });
      assert.deepStrictEqual(executed, [[122, "DropUnusedCommandReceiptIndexes"]]);

      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_command_receipts'
      `;
      assert.deepStrictEqual(
        after.map(({ name }) => name),
        ["sqlite_autoindex_orchestration_command_receipts_1"],
      );
    }),
  );
});

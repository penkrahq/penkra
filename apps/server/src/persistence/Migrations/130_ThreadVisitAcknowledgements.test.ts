import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("130_ThreadVisitAcknowledgements", (it) => {
  it.effect("adds a durable nullable acknowledgement without inventing one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 129 });
      yield* runMigrations({ toMigrationInclusive: 130 });
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads') WHERE name = 'last_visited_at'
      `;
      assert.deepStrictEqual(columns, [{ name: "last_visited_at" }]);
    }),
  );
});

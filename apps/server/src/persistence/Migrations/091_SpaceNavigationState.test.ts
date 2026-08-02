import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("091_SpaceNavigationState", (it) => {
  it.effect("creates the durable singleton navigation table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 90 });

      const executed = yield* runMigrations({ toMigrationInclusive: 91 });
      assert.deepStrictEqual(executed, [[91, "SpaceNavigationState"]]);

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('space_navigation_state')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        [
          "singleton_id",
          "active_space_id",
          "last_thread_id_by_space_json",
          "last_project_id_by_space_json",
          "updated_at",
        ],
      );
    }),
  );
});

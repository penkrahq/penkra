import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const tableColumnNames = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info(${tableName})
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("041_ProjectionProjectsPinned", (it) => {
  it.effect("adds durable project pin state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const beforeColumns = yield* tableColumnNames(sql, "projection_projects");
      assert.notInclude(beforeColumns, "is_pinned");

      yield* runMigrations({ toMigrationInclusive: 41 });

      const afterColumns = yield* tableColumnNames(sql, "projection_projects");
      assert.include(afterColumns, "is_pinned");
    }),
  );

  it.effect("is a no-op when project pin state already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* tableColumnNames(sql, "projection_projects");
      assert.include(columns, "is_pinned");
    }),
  );
});

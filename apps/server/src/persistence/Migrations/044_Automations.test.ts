import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const tableNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'automation_%'
    ORDER BY name ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const indexNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'idx_automation_%'
    ORDER BY name ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const viewNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'view' AND name LIKE 'automation_%'
    ORDER BY name ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("legacy automation migration lineage", (it) => {
  it.effect("retains the historical migration ids required by existing databases", () =>
    Effect.sync(() => {
      // Look the entry up by id: asserting on the lineage tail would break
      // every time an unrelated migration lands after it.
      const entry = migrationEntries.find(([id]) => id === 48);
      assert.deepStrictEqual(entry?.slice(0, 2), [48, "AutomationCompletionEvaluationBacklog"]);
    }),
  );

  it.effect("removes all legacy automation storage after the full lineage runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      assert.deepStrictEqual(yield* tableNames(sql), []);
      assert.deepStrictEqual(yield* indexNames(sql), []);
      assert.deepStrictEqual(yield* viewNames(sql), []);
    }),
  );
});

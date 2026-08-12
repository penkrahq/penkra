import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("038_ReconcileLegacySidechatSource", (it) => {
  it.effect("heals legacy DBs whose tracker recorded a foreign migration 33", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'BackfillMissingLiveThreadProjects')
      `;

      // The lineage reconciler spots the foreign row at ID 33 before the
      // migrator runs, so Penkra's 33 is replayed in the same pass instead of
      // being skipped by the max-ID gate.
      yield* runMigrations({ toMigrationInclusive: 37 });

      const afterColumns = yield* projectionThreadsColumnNames(sql);
      assert.include(afterColumns, "sidechat_source_thread_id");

      const [row33] = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 33
      `;
      assert.strictEqual(row33?.name, "ProjectionThreadsSidechatSource");

      yield* runMigrations({ toMigrationInclusive: 95 });

      const finalColumnsBeforeRemoval = yield* projectionThreadsColumnNames(sql);
      assert.include(finalColumnsBeforeRemoval, "sidechat_source_thread_id");
    }),
  );

  it.effect("is a no-op before the legacy sidechat column is retired", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* runMigrations({ toMigrationInclusive: 95 });

      const columns = yield* projectionThreadsColumnNames(sql);
      assert.include(columns, "sidechat_source_thread_id");
    }),
  );
});

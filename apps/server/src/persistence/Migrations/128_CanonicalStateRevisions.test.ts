import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const canonicalTables = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_turns",
  "projection_thread_sessions",
  "projection_projects",
  "projection_spaces",
  "projection_pending_interactions",
  "operations",
  "notices",
  "connection_rate_limits",
  "connection_usage_daily",
] as const;

layer("128_CanonicalStateRevisions", (it) => {
  it.effect("does not create unused row-delta revision schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 128 });
      for (const table of canonicalTables) {
        const columns = yield* sql.unsafe<{ readonly name: string }>(
          `SELECT name FROM pragma_table_info('${table}') WHERE name = 'updated_seq'`,
        );
        assert.deepStrictEqual(columns, []);
      }
      const sequenceTables = yield* sql<{ readonly present: number }>`
        SELECT COUNT(*) AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = 'canonical_state_sequence'
      `;
      assert.strictEqual(sequenceTables[0]?.present, 0);
    }),
  );
});

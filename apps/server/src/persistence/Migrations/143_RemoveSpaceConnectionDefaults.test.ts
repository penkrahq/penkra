import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("143_RemoveSpaceConnectionDefaults", (it) => {
  it.effect("drops the obsolete table and every trigger that maintained it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 142 });

      const before = yield* sql<{ readonly name: string; readonly type: string }>`
        SELECT name, type FROM sqlite_master
        WHERE name IN (
          'space_connection_defaults',
          'provider_connections_default_unconfigured_spaces',
          'projection_spaces_default_active_connections',
          'provider_connections_replace_terminated_space_default',
          'space_connection_defaults_compatible_insert',
          'space_connection_defaults_compatible_update'
        )
        ORDER BY type, name
      `;
      assert.isTrue(before.some((entry) => entry.type === "table"));
      assert.isTrue(before.some((entry) => entry.type === "trigger"));

      yield* runMigrations({ toMigrationInclusive: 143 });

      const after = yield* sql<{ readonly name: string; readonly type: string }>`
        SELECT name, type FROM sqlite_master
        WHERE name IN (
          'space_connection_defaults',
          'provider_connections_default_unconfigured_spaces',
          'projection_spaces_default_active_connections',
          'provider_connections_replace_terminated_space_default',
          'space_connection_defaults_compatible_insert',
          'space_connection_defaults_compatible_update'
        )
      `;
      assert.deepStrictEqual(after, []);
    }),
  );
});

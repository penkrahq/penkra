import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("160_ProjectionTurnPendingMessageLookup", (it) => {
  it.effect("indexes exact thread-scoped pending message identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 160 });
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_projection_turns_thread_pending_message'
      `;
      assert.deepStrictEqual(indexes, [{ name: "idx_projection_turns_thread_pending_message" }]);
    }),
  );
});

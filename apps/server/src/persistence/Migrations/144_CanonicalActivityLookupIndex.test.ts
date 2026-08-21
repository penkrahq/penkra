import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("144_CanonicalActivityLookupIndex", (it) => {
  it.effect(
    "covers canonical activity identity lookups without scanning a Thread's operations",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();

        const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT 1
        FROM operations
        WHERE thread_id = 'thread-query-plan'
          AND COALESCE(turn_id, '') = 'turn-query-plan'
          AND provider_operation_id = 'operation-query-plan'
      `;

        assert.isTrue(
          plan.some(({ detail }) => detail.includes("idx_operations_activity_identity")),
        );
        assert.isFalse(plan.some(({ detail }) => detail.includes("SCAN operations")));
      }),
  );
});

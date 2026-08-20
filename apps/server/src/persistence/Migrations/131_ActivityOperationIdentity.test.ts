import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("131_ActivityOperationIdentity", (it) => {
  it.effect("backfills only explicit operation identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 130 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES
          ('explicit', 'thread-1', NULL, 'info', 'tool.completed', 'done',
           '{"operationId":"operation-1"}', '2026-08-19T00:00:00.000Z'),
          ('missing', 'thread-1', NULL, 'info', 'tool.completed', 'done',
           '{"toolCallId":"similar-but-not-proof"}', '2026-08-19T00:00:01.000Z'),
          ('empty', 'thread-1', NULL, 'info', 'tool.completed', 'done',
           '{"operationId":""}', '2026-08-19T00:00:02.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 131 });
      const rows = yield* sql<{
        readonly activityId: string;
        readonly operationId: string | null;
      }>`
        SELECT activity_id AS "activityId", operation_id AS "operationId"
        FROM projection_thread_activities
        ORDER BY activity_id
      `;
      assert.deepStrictEqual(rows, [
        { activityId: "empty", operationId: null },
        { activityId: "explicit", operationId: "operation-1" },
        { activityId: "missing", operationId: null },
      ]);
      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1' AND operation_id = 'operation-1'
      `;
      assert.isTrue(
        queryPlan.some(({ detail }) =>
          detail.includes("idx_projection_thread_activities_thread_operation"),
        ),
      );
    }),
  );
});

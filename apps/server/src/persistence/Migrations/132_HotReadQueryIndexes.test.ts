import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const planUses = (rows: ReadonlyArray<{ readonly detail: string }>, index: string) =>
  rows.some(({ detail }) => detail.includes(index));

layer("132_HotReadQueryIndexes", (it) => {
  it.effect("keeps canonical Thread message and activity reads on covering indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const messagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id
        FROM projection_thread_messages
        WHERE thread_id = 'thread-query-plan'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          message_id ASC
      `;
      assert.isTrue(planUses(messagePlan, "idx_projection_thread_messages_canonical_order"));
      assert.isFalse(messagePlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")));

      const userMessagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT created_at
        FROM projection_thread_messages
        WHERE thread_id = 'thread-query-plan' AND role = 'user'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
          sequence DESC,
          created_at DESC,
          message_id DESC
        LIMIT 1
      `;
      assert.isTrue(planUses(userMessagePlan, "idx_projection_thread_messages_latest_user"));
      assert.isFalse(userMessagePlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")));

      const activityPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-query-plan'
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `;
      assert.isTrue(planUses(activityPlan, "idx_projection_thread_activities_thread_rank_desc"));
      assert.isFalse(activityPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")));

      const fileChangePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT payload_json
        FROM projection_thread_activities
        WHERE thread_id = 'thread-query-plan' AND kind = 'tool.completed'
        ORDER BY created_at DESC, activity_id DESC
        LIMIT 500
      `;
      assert.isTrue(planUses(fileChangePlan, "idx_projection_thread_activities_kind_created"));
      assert.isFalse(fileChangePlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")));
    }),
  );
});

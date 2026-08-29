import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("154_RestartReconciliationIndexes", (it) => {
  it.effect("uses narrow partial indexes for both orphan scans", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const messagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id, message_id
        FROM projection_thread_messages
        WHERE role = 'assistant' AND is_streaming = 1
      `;
      const interactionPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id, request_id
        FROM projection_pending_interactions
        WHERE status <> 'confirmed'
      `;

      assert.isTrue(
        messagePlan.some(({ detail }) =>
          detail.includes("idx_projection_thread_messages_streaming_assistant"),
        ),
      );
      assert.isTrue(
        interactionPlan.some(({ detail }) =>
          detail.includes("idx_projection_pending_interactions_unresolved"),
        ),
      );
    }),
  );
});

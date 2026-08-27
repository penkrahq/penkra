import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("TypedLegacyPendingInteractionFailures migration", (it) => {
  it.effect("translates only the exact historical stale-callback representation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 151 });

      const callbackSuffix =
        ". Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, runtime_mode, created_at, updated_at,
          pending_approval_count, pending_user_input_count, work_status
        ) VALUES (
          'thread-1', 'folder-1', 'Historical stale questions',
          '{"provider":"codex","model":"test-model"}', 'full-access',
          '2026-08-24T17:00:00.000Z', '2026-08-24T17:00:00.000Z',
          1, 2, 'attention'
        )
      `;
      yield* sql`
        INSERT INTO projection_pending_interactions (
          interaction_kind, request_id, thread_id, turn_id,
          lifecycle_generation, status, decision, response_command_id,
          response_requested_at, created_at, resolved_at
        ) VALUES
          (
            'approval', 'approval-1', 'thread-1', NULL, NULL,
            'pending', NULL, NULL, NULL, '2026-08-24T17:00:01.000Z', NULL
          ),
          (
            'userInput', 'input-1', 'thread-1', NULL, NULL,
            'pending', NULL, NULL, NULL, '2026-08-24T17:00:02.000Z', NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, sequence, created_at
        ) VALUES
          (
            'legacy-approval', 'thread-1', NULL, 'error',
            'provider.approval.respond.failed', 'Provider approval response failed',
            ${JSON.stringify({
              requestId: "approval-1",
              detail: `Stale pending approval request: approval-1${callbackSuffix}`,
            })},
            1, '2026-08-24T17:00:33.013Z'
          ),
          (
            'legacy-user-input', 'thread-1', NULL, 'error',
            'provider.user-input.respond.failed', 'Provider user input response failed',
            ${JSON.stringify({
              requestId: "input-1",
              detail: `Stale pending user-input request: input-1${callbackSuffix}`,
            })},
            2, '2026-08-24T17:00:33.014Z'
          ),
          (
            'retryable-runtime-inactive', 'thread-1', NULL, 'error',
            'provider.user-input.respond.failed', 'Provider user input response failed',
            ${JSON.stringify({
              requestId: "input-2",
              detail: "Cannot respond because the provider runtime is not active.",
              settlementStatus: "retryable",
            })},
            3, '2026-08-24T17:00:33.015Z'
          )
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 153 }), [
        [152, "TypedLegacyPendingInteractionFailures"],
        [153, "TypedLegacyPendingInteractionProjectionRepair"],
      ]);
      const rows = yield* sql<{
        readonly activityId: string;
        readonly failureCode: string | null;
      }>`
        SELECT
          activity_id AS "activityId",
          json_extract(payload_json, '$.failureCode') AS "failureCode"
        FROM projection_thread_activities
        WHERE activity_id IN (
          'legacy-approval',
          'legacy-user-input',
          'retryable-runtime-inactive'
        )
        ORDER BY activity_id
      `;
      assert.deepStrictEqual(rows, [
        { activityId: "legacy-approval", failureCode: "PENDING_INTERACTION_NOT_FOUND" },
        { activityId: "legacy-user-input", failureCode: "PENDING_INTERACTION_NOT_FOUND" },
        { activityId: "retryable-runtime-inactive", failureCode: null },
      ]);
      const interactions = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM projection_pending_interactions
        WHERE thread_id = 'thread-1'
        ORDER BY request_id
      `;
      assert.deepStrictEqual(interactions, [
        {
          requestId: "approval-1",
          status: "confirmed",
          resolvedAt: "2026-08-24T17:00:33.013Z",
        },
        {
          requestId: "input-1",
          status: "confirmed",
          resolvedAt: "2026-08-24T17:00:33.014Z",
        },
      ]);
      const [thread] = yield* sql<{
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
        readonly workStatus: string;
      }>`
        SELECT
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          work_status AS "workStatus"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(thread, {
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        workStatus: "idle",
      });
    }),
  );
});

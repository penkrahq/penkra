import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 152 typed historical stale-callback activities. Their separately
 * materialized interaction rows and sidebar counts must converge as well.
 * This is a distinct migration because development databases may already have
 * applied 152 before the projection repair was identified.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_pending_interactions AS interaction
    SET status = 'confirmed',
        resolved_at = COALESCE(
          (
            SELECT activity.created_at
            FROM projection_thread_activities AS activity
            WHERE activity.thread_id = interaction.thread_id
              AND activity.kind = CASE interaction.interaction_kind
                WHEN 'approval' THEN 'provider.approval.respond.failed'
                ELSE 'provider.user-input.respond.failed'
              END
              AND json_extract(activity.payload_json, '$.requestId') = interaction.request_id
              AND json_extract(activity.payload_json, '$.failureCode') =
                'PENDING_INTERACTION_NOT_FOUND'
              AND (
                json_extract(activity.payload_json, '$.lifecycleGeneration') IS NULL
                OR json_extract(activity.payload_json, '$.lifecycleGeneration') =
                  interaction.lifecycle_generation
              )
            ORDER BY activity.sequence DESC
            LIMIT 1
          ),
          resolved_at
        )
    WHERE status <> 'confirmed'
      AND EXISTS (
        SELECT 1
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = interaction.thread_id
          AND activity.kind = CASE interaction.interaction_kind
            WHEN 'approval' THEN 'provider.approval.respond.failed'
            ELSE 'provider.user-input.respond.failed'
          END
          AND json_extract(activity.payload_json, '$.requestId') = interaction.request_id
          AND json_extract(activity.payload_json, '$.failureCode') =
            'PENDING_INTERACTION_NOT_FOUND'
          AND (
            json_extract(activity.payload_json, '$.lifecycleGeneration') IS NULL
            OR json_extract(activity.payload_json, '$.lifecycleGeneration') =
              interaction.lifecycle_generation
          )
      )
  `;

  yield* sql`
    UPDATE projection_threads AS thread
    SET pending_approval_count = (
          SELECT COUNT(*)
          FROM projection_pending_interactions AS interaction
          WHERE interaction.thread_id = thread.thread_id
            AND interaction.interaction_kind = 'approval'
            AND interaction.status IN ('pending', 'retryable')
        ),
        pending_user_input_count = (
          SELECT COUNT(*)
          FROM projection_pending_interactions AS interaction
          WHERE interaction.thread_id = thread.thread_id
            AND interaction.interaction_kind = 'userInput'
            AND interaction.status IN ('pending', 'retryable')
        )
    WHERE thread.thread_id IN (
      SELECT DISTINCT activity.thread_id
      FROM projection_thread_activities AS activity
      WHERE json_extract(activity.payload_json, '$.failureCode') =
        'PENDING_INTERACTION_NOT_FOUND'
        AND activity.kind IN (
          'provider.approval.respond.failed',
          'provider.user-input.respond.failed'
        )
    )
  `;
});

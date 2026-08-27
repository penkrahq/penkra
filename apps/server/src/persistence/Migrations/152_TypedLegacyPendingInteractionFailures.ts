import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const CALLBACK_STATE_SUFFIX =
  ". Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.";

/**
 * Migration 151 and earlier stored the stale-callback classification only in
 * the standardized detail string. The current read model deliberately accepts
 * only the typed failure code, so translate that exact historical wire shape
 * once instead of retaining fuzzy text classification in runtime code.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_thread_activities
    SET payload_json = json_set(
      payload_json,
      '$.failureCode',
      'PENDING_INTERACTION_NOT_FOUND'
    )
    WHERE kind IN (
      'provider.approval.respond.failed',
      'provider.user-input.respond.failed'
    )
      AND json_type(payload_json, '$.requestId') = 'text'
      AND json_extract(payload_json, '$.failureCode') IS NULL
      AND json_extract(payload_json, '$.detail') =
        'Stale pending ' ||
        CASE kind
          WHEN 'provider.approval.respond.failed' THEN 'approval'
          ELSE 'user-input'
        END ||
        ' request: ' || json_extract(payload_json, '$.requestId') ||
        ${CALLBACK_STATE_SUFFIX}
  `;
});

// FILE: 096_RemoveSidechatAndProviderHandoff.ts
// Purpose: Removes the rejected Sidechat and cross-provider Handoff data model.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasSidechatColumn = yield* columnExists(
    sql,
    "projection_threads",
    "sidechat_source_thread_id",
  );
  const hasHandoffColumn = yield* columnExists(sql, "projection_threads", "handoff_json");
  const hasProposedPlansTable = yield* tableExists(sql, "projection_thread_proposed_plans");
  const hasRetiredGitTable = yield* tableExists(sql, "git_handoff_operations");
  const hasGitEnvironmentTable = yield* tableExists(sql, "git_thread_environment_operations");

  yield* sql`
    CREATE TEMP TABLE removed_legacy_thread_ids (
      thread_id TEXT PRIMARY KEY
    )
  `;

  if (hasSidechatColumn && hasHandoffColumn) {
    yield* sql`
      INSERT OR IGNORE INTO removed_legacy_thread_ids (thread_id)
      SELECT thread_id
      FROM projection_threads
      WHERE sidechat_source_thread_id IS NOT NULL
         OR handoff_json IS NOT NULL
    `;
  } else if (hasSidechatColumn) {
    yield* sql`
      INSERT OR IGNORE INTO removed_legacy_thread_ids (thread_id)
      SELECT thread_id
      FROM projection_threads
      WHERE sidechat_source_thread_id IS NOT NULL
    `;
  } else if (hasHandoffColumn) {
    yield* sql`
      INSERT OR IGNORE INTO removed_legacy_thread_ids (thread_id)
      SELECT thread_id
      FROM projection_threads
      WHERE handoff_json IS NOT NULL
    `;
  }

  yield* sql`
    INSERT OR IGNORE INTO removed_legacy_thread_ids (thread_id)
    SELECT stream_id
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.created'
      AND (
        json_type(payload_json, '$.sidechatSourceThreadId') = 'text'
        OR json_type(payload_json, '$.handoff') = 'object'
      )
  `;

  yield* sql`DELETE FROM projection_pending_interactions WHERE thread_id IN removed_legacy_thread_ids`;
  if (hasProposedPlansTable) {
    yield* sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id IN removed_legacy_thread_ids`;
  }
  yield* sql`DELETE FROM projection_thread_messages WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM projection_thread_activities WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM projection_turns WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM provider_session_runtime WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM orchestration_event_deliveries WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM queued_turn_promotions WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM provider_delivery_reconciliations WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM provider_runtime_events WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM provider_runtime_open_turns WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM provider_runtime_projection_failures WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM provider_runtime_thread_cursors WHERE thread_id IN removed_legacy_thread_ids`;
  if (hasRetiredGitTable) {
    yield* sql`DELETE FROM git_handoff_operations WHERE thread_id IN removed_legacy_thread_ids`;
  }
  if (hasGitEnvironmentTable) {
    yield* sql`
      DELETE FROM git_thread_environment_operations
      WHERE thread_id IN removed_legacy_thread_ids
    `;
  }
  yield* sql`DELETE FROM operational_diagnostics WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM managed_attachment_blobs WHERE owner_thread_id IN removed_legacy_thread_ids`;
  yield* sql`DELETE FROM projection_threads WHERE thread_id IN removed_legacy_thread_ids`;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND stream_id IN removed_legacy_thread_ids
  `;

  yield* sql`DROP TABLE removed_legacy_thread_ids`;
  if (hasSidechatColumn) {
    yield* sql`ALTER TABLE projection_threads DROP COLUMN sidechat_source_thread_id`;
  }
  if (hasHandoffColumn) {
    yield* sql`ALTER TABLE projection_threads DROP COLUMN handoff_json`;
  }
});

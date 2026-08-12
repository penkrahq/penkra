// FILE: 106_RemovePlanMode.ts
// Purpose: Preserve historical plan text as ordinary assistant messages, then remove Plan mode.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Materialize the current projection immediately so an upgraded database does
  // not need a full event replay before historical plan text becomes visible.
  if (yield* tableExists(sql, "projection_thread_proposed_plans")) {
    yield* sql.unsafe(`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming,
        created_at, updated_at, source
      )
      SELECT
        'legacy-proposed-plan:' || plan_id,
        thread_id,
        turn_id,
        'assistant',
        plan_markdown,
        0,
        created_at,
        updated_at,
        'native'
      FROM projection_thread_proposed_plans
      WHERE trim(plan_markdown) != ''
      ON CONFLICT (thread_id, message_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        text = excluded.text,
        is_streaming = 0,
        updated_at = excluded.updated_at
    `);
  }

  // Keep event replay authoritative by converting each proposal upsert into an
  // ordinary assistant-message upsert with a stable thread-scoped message id.
  if (yield* tableExists(sql, "orchestration_events")) {
    yield* sql.unsafe(`
      UPDATE orchestration_events
    SET
      event_type = 'thread.message-sent',
      payload_json = json_object(
        'threadId', json_extract(payload_json, '$.threadId'),
        'messageId', 'legacy-proposed-plan:' || json_extract(payload_json, '$.proposedPlan.id'),
        'role', 'assistant',
        'text', json_extract(payload_json, '$.proposedPlan.planMarkdown'),
        'turnId', json_extract(payload_json, '$.proposedPlan.turnId'),
        'streaming', json('false'),
        'source', 'native',
        'createdAt', json_extract(payload_json, '$.proposedPlan.createdAt'),
        'updatedAt', json_extract(payload_json, '$.proposedPlan.updatedAt')
      )
    WHERE event_type = 'thread.proposed-plan-upserted'
      AND json_valid(payload_json)
      AND trim(COALESCE(json_extract(payload_json, '$.proposedPlan.planMarkdown'), '')) != ''
    `);
    yield* sql.unsafe(`
      DELETE FROM orchestration_events
      WHERE event_type IN ('thread.interaction-mode-set', 'thread.proposed-plan-upserted')
    `);
  }

  // Provider proposal events have already been projected into the durable
  // orchestration history above. They are no longer part of the runtime protocol.
  if (yield* tableExists(sql, "provider_runtime_events")) {
    yield* sql.unsafe(`
      DELETE FROM provider_runtime_events
      WHERE event_type IN ('turn.proposed.delta', 'turn.proposed.completed')
    `);
  }

  yield* sql.unsafe(`DROP TABLE IF EXISTS projection_thread_proposed_plans`);
  if (yield* columnExists(sql, "projection_threads", "interaction_mode")) {
    yield* sql.unsafe(`ALTER TABLE projection_threads DROP COLUMN interaction_mode`);
  }
  if (yield* columnExists(sql, "projection_threads", "has_actionable_proposed_plan")) {
    yield* sql.unsafe(`ALTER TABLE projection_threads DROP COLUMN has_actionable_proposed_plan`);
  }
  if (yield* columnExists(sql, "projection_turns", "source_proposed_plan_thread_id")) {
    yield* sql.unsafe(`ALTER TABLE projection_turns DROP COLUMN source_proposed_plan_thread_id`);
  }
  if (yield* columnExists(sql, "projection_turns", "source_proposed_plan_id")) {
    yield* sql.unsafe(`ALTER TABLE projection_turns DROP COLUMN source_proposed_plan_id`);
  }
  if (yield* tableExists(sql, "projection_state")) {
    yield* sql.unsafe(`
      DELETE FROM projection_state
      WHERE projector = 'projection.thread-proposed-plans'
    `);
  }
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { THREAD_ITEM_DATA_LIMIT_BYTES } from "../../cleanCore/threadItemData.ts";

/**
 * Clean-core schema and Production backfill (0.14.4).
 *
 * Creates the two canonical tables (`threads`, `thread_items`) plus the FTS
 * index, and fills them from the replaced projection tables. Additive only:
 * the replaced tables are dropped in the later cleanup migration once no code
 * reads them, so every intermediate commit keeps the old suites green.
 *
 * Mapping (documented, count-verified by the rehearsal):
 * - threads.space_id comes from the thread's folder (threads carry a null
 *   space in Production; every folder has one).
 * - threads.provider/model come from `model_selection_json`; connection_id
 *   from `projection_threads.connection_id` (falling back to the runtime
 *   binding); provider_session_id from `provider_session_runtime`'s resume
 *   cursor `$.threadId`; native_state_id from the active native-state
 *   generation; state is `idle`.
 * - thread_items: messages -> user/text/notice; tool activities collapse into
 *   one item per operation (from `operations`, else the latest activity for
 *   that operation); remaining transcript activities -> notice; `notices` ->
 *   notice; `userInput` pending interactions -> question. Internal bookkeeping
 *   activities (context window, rate limits, reconciliation, turn task
 *   summaries) and every approval are not transcript items and are dropped.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      folder_id TEXT,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      connection_id TEXT,
      model TEXT NOT NULL,
      model_options TEXT,
      provider_session_id TEXT,
      native_state_id TEXT,
      state TEXT NOT NULL,
      active_turn_id TEXT,
      last_error TEXT,
      draft TEXT,
      draft_updated_at TEXT,
      queue TEXT NOT NULL DEFAULT '[]',
      archived_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_items (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT,
      data TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, seq),
      UNIQUE (thread_id, source_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_items_thread_seq
    ON thread_items(thread_id, seq DESC)
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS thread_items_search
    USING fts5(
      text,
      content = 'thread_items',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    )
  `;
  yield* sql`
    INSERT INTO thread_items_search(thread_items_search) VALUES ('rebuild')
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS thread_items_search_insert
    AFTER INSERT ON thread_items BEGIN
      INSERT INTO thread_items_search(rowid, text) VALUES (NEW.rowid, NEW.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS thread_items_search_update
    AFTER UPDATE OF thread_id, source_id, text ON thread_items BEGIN
      INSERT INTO thread_items_search(thread_items_search, rowid, text)
      VALUES ('delete', OLD.rowid, OLD.text);
      INSERT INTO thread_items_search(rowid, text) VALUES (NEW.rowid, NEW.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS thread_items_search_delete
    AFTER DELETE ON thread_items BEGIN
      INSERT INTO thread_items_search(thread_items_search, rowid, text)
      VALUES ('delete', OLD.rowid, OLD.text);
    END
  `;

  // ---- threads ------------------------------------------------------------
  yield* sql`
    INSERT OR IGNORE INTO threads (
      id, space_id, folder_id, title, provider, connection_id, model,
      model_options, provider_session_id, native_state_id, state,
      active_turn_id, last_error, draft, draft_updated_at, queue,
      archived_at, deleted_at, created_at, updated_at
    )
    SELECT
      t.thread_id,
      COALESCE(f.space_id, 'penkra-personal'),
      t.folder_id,
      t.title,
      COALESCE(json_extract(t.model_selection_json, '$.provider'), 'codex'),
      COALESCE(t.connection_id, b.connection_id),
      COALESCE(json_extract(t.model_selection_json, '$.model'), 'unknown'),
      NULL,
      (SELECT json_extract(r.resume_cursor_json, '$.threadId')
         FROM provider_session_runtime r WHERE r.thread_id = t.thread_id),
      (SELECT g.native_state_generation_id
         FROM provider_native_state_generations g
        WHERE g.owner_thread_id = t.thread_id AND g.lifecycle = 'active'
        LIMIT 1),
      'idle', NULL, NULL, NULL, NULL, '[]',
      t.archived_at, t.deleted_at, t.created_at, t.updated_at
    FROM projection_threads t
    LEFT JOIN projection_folders f ON f.folder_id = t.folder_id
    LEFT JOIN thread_runtime_bindings b ON b.thread_id = t.thread_id
  `;

  // ---- thread_items -------------------------------------------------------
  yield* sql`DROP TABLE IF EXISTS temp.clean_core_items`;
  yield* sql`
    CREATE TEMP TABLE clean_core_items (
      thread_id TEXT NOT NULL,
      sort_at TEXT NOT NULL,
      sort_seq INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT,
      data TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Messages: user -> user, assistant -> text, system -> notice.
  yield* sql`
    INSERT INTO temp.clean_core_items
    SELECT
      m.thread_id,
      m.created_at,
      COALESCE(m.sequence, 0),
      m.message_id,
      m.turn_id,
      CASE m.role WHEN 'user' THEN 'user' WHEN 'assistant' THEN 'text' ELSE 'notice' END,
      CASE
        WHEN m.role = 'assistant' THEN CASE WHEN m.is_streaming = 1 THEN 'streaming' ELSE 'done' END
        WHEN m.role = 'user' THEN
          CASE
            WHEN m.delivery_state = 'queued' THEN 'queued'
            WHEN m.delivery_state = 'failed' THEN 'failed'
            ELSE 'sent'
          END
        ELSE 'done'
      END,
      m.text,
      NULLIF(
        json_object(
          'attachments', json(COALESCE(m.attachments_json, 'null')),
          'skills', json(COALESCE(m.skills_json, 'null')),
          'mentions', json(COALESCE(m.mentions_json, 'null')),
          'dispatchMode', m.dispatch_mode,
          'dispatchOrigin', m.dispatch_origin
        ),
        '{}'
      ),
      m.created_at,
      m.updated_at
    FROM projection_thread_messages m
  `;

  // Tool items: one per operation.
  yield* sql`
    INSERT INTO temp.clean_core_items
    SELECT
      o.thread_id,
      o.started_at,
      COALESCE(o.presentation_sequence, 0),
      o.operation_id,
      o.turn_id,
      'tool',
      CASE o.status
        WHEN 'completed' THEN 'done'
        WHEN 'failed' THEN 'error'
        WHEN 'cancelled' THEN 'error'
        WHEN 'aborted' THEN 'error'
        WHEN 'interrupted' THEN 'error'
        ELSE 'running'
      END,
      -- Old OpenCode subagent results wrap the answer in a task/task_result
      -- element pair; the transcript shows the plain result text, not the wrapper.
      CASE
        WHEN instr(o.activity_json, '<task_result>') > 0
          AND instr(o.activity_json, '</task_result>') >
            instr(o.activity_json, '<task_result>') + 13
        THEN trim(substr(
          o.activity_json,
          instr(o.activity_json, '<task_result>') + 13,
          instr(o.activity_json, '</task_result>') -
            (instr(o.activity_json, '<task_result>') + 13)
        ), ' ' || char(9) || char(10) || char(13))
        ELSE COALESCE(o.title, json_extract(o.activity_json, '$.summary'), o.item_type)
      END,
      CASE
        WHEN length(o.activity_json) <= ${THREAD_ITEM_DATA_LIMIT_BYTES} THEN o.activity_json
        ELSE json_object(
          'truncated', json('true'),
          'originalBytes', length(o.activity_json),
          'preview', substr(o.activity_json, 1, ${THREAD_ITEM_DATA_LIMIT_BYTES})
        )
      END,
      o.started_at,
      o.updated_at
    FROM operations o
  `;

  // Remaining transcript activities not owned by an operation or notice.
  yield* sql`
    INSERT INTO temp.clean_core_items
    SELECT
      a.thread_id,
      a.created_at,
      COALESCE(a.sequence, 0),
      a.activity_id,
      a.turn_id,
      CASE
        WHEN a.kind = 'reasoning' THEN 'reasoning'
        ELSE 'notice'
      END,
      'done',
      a.summary,
      a.payload_json,
      a.created_at,
      a.created_at
    FROM projection_thread_activities a
    WHERE a.operation_id IS NULL
      AND a.kind IN ('runtime.warning', 'context-compaction', 'media.presented', 'reasoning')
      AND NOT EXISTS (SELECT 1 FROM notices n WHERE n.notice_id = a.activity_id)
  `;

  yield* sql`
    INSERT INTO temp.clean_core_items
    SELECT
      n.thread_id,
      n.created_at,
      COALESCE(n.presentation_sequence, 0),
      n.notice_id,
      n.turn_id,
      'notice',
      'done',
      n.summary,
      n.detail_json,
      n.created_at,
      n.created_at
    FROM notices n
    WHERE n.kind NOT LIKE 'approval%'
  `;

  // Open/answered questions from the indexed pending-interaction table.
  yield* sql`
    INSERT INTO temp.clean_core_items
    SELECT
      p.thread_id,
      p.created_at,
      0,
      'question:' || p.request_id,
      p.turn_id,
      'question',
      CASE WHEN p.status = 'confirmed' THEN 'answered' ELSE 'open' END,
      COALESCE(
        (SELECT a.summary FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id
            AND json_extract(a.payload_json, '$.requestId') = p.request_id
          ORDER BY a.created_at DESC, a.activity_id DESC LIMIT 1),
        'Question'
      ),
      json_object('requestId', p.request_id, 'decision', p.decision),
      p.created_at,
      COALESCE(p.resolved_at, p.created_at)
    FROM projection_pending_interactions p
    WHERE p.interaction_kind = 'userInput'
  `;

  // Assign the immutable transcript position in time order per thread.
  yield* sql`
    INSERT OR IGNORE INTO thread_items (
      thread_id, seq, source_id, turn_id, kind, status, text, data, created_at, updated_at
    )
    SELECT
      thread_id,
      ROW_NUMBER() OVER (
        PARTITION BY thread_id
        ORDER BY sort_at ASC, sort_seq ASC, source_id ASC
      ),
      source_id, turn_id, kind, status, text, data, created_at, updated_at
    FROM temp.clean_core_items
  `;

  yield* sql`DROP TABLE IF EXISTS temp.clean_core_items`;
});

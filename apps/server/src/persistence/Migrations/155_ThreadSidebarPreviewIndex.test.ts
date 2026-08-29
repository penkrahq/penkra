import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("155_ThreadSidebarPreviewIndex", (it) => {
  it.effect("serves the exact sidebar rollup order without a temporary sort", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const timestamp = "2026-08-29T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, kind, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES ('project-1', 'folder', 'Project', '/workspace', NULL, '[]', ${timestamp}, ${timestamp})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES ('thread-1', 'project-1', 'Thread', '{"provider":"codex","model":"gpt-5.5"}',
                  'full-access', ${timestamp}, ${timestamp})
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, applied_len,
          source, sequence, created_at, updated_at
        ) VALUES
          ('message-1', 'thread-1', 'assistant', 'older', 0, 5, 'provider', 1, ${timestamp}, ${timestamp}),
          ('message-2', 'thread-1', 'assistant', 'newer', 1, 5, 'provider', 2, ${timestamp}, ${timestamp})
      `;
      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT substr(message.text, 1, 240)
        FROM projection_thread_messages AS message
        WHERE message.thread_id = 'thread-1'
        ORDER BY COALESCE(message.sequence, -1) DESC,
                 message.created_at DESC,
                 message.message_id DESC
        LIMIT 1
      `;
      assert.isTrue(
        queryPlan.some(({ detail }) =>
          detail.includes("idx_projection_thread_messages_sidebar_preview"),
        ),
      );
      assert.isFalse(queryPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE")));

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'newest preview', applied_len = 14, updated_at = ${timestamp}
        WHERE thread_id = 'thread-1' AND message_id = 'message-2'
      `;
      const rows = yield* sql<{ readonly preview: string }>`
        SELECT last_message_preview AS preview
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(rows[0]?.preview, "newest preview");
    }),
  );
});

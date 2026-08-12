import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("096_RemoveSidechatAndProviderHandoff", (it) => {
  it.effect("discards rejected legacy threads and drops their live columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'folder-1', 'project', 'Folder', NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
          sidechat_source_thread_id, handoff_json, created_at, updated_at
        ) VALUES
          ('ordinary', 'folder-1', 'Ordinary', 'full-access', 'default', 'local',
            NULL, NULL, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
          ('sidechat', 'folder-1', 'Sidechat', 'full-access', 'default', 'local',
            'ordinary', NULL, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
          ('provider-handoff', 'folder-1', 'Handoff', 'full-access', 'default', 'local',
            NULL, '{"sourceThreadId":"ordinary"}',
            '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('ordinary-message', 'ordinary', 'user', 'keep', 0,
            '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
          ('sidechat-message', 'sidechat', 'user', 'discard', 0,
            '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          ('ordinary-created', 'thread', 'ordinary', 1, 'thread.created',
            '2026-01-01T00:00:01.000Z', 'system', '{"threadId":"ordinary"}', '{}'),
          ('sidechat-created', 'thread', 'sidechat', 1, 'thread.created',
            '2026-01-01T00:00:02.000Z', 'system',
            '{"threadId":"sidechat","sidechatSourceThreadId":"ordinary"}', '{}'),
          ('handoff-created', 'thread', 'provider-handoff', 1, 'thread.created',
            '2026-01-01T00:00:03.000Z', 'system',
            '{"threadId":"provider-handoff","handoff":{"sourceThreadId":"ordinary"}}', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 96 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      const columnNames = columns.map((column) => column.name);
      assert.notInclude(columnNames, "sidechat_source_thread_id");
      assert.notInclude(columnNames, "handoff_json");

      const threads = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM projection_threads ORDER BY thread_id
      `;
      assert.deepStrictEqual(threads, [{ thread_id: "ordinary" }]);
      const messages = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM projection_thread_messages ORDER BY message_id
      `;
      assert.deepStrictEqual(messages, [{ message_id: "ordinary-message" }]);
      const events = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events ORDER BY event_id
      `;
      assert.deepStrictEqual(events, [{ event_id: "ordinary-created" }]);
    }),
  );
});

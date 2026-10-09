import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("backfills threads and thread_items from the replaced projection tables", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 175 });

      const now = "2026-10-09T00:00:00.000Z";
      const t1 = "2026-10-09T00:00:01.000Z";
      const t2 = "2026-10-09T00:00:02.000Z";
      const t3 = "2026-10-09T00:00:03.000Z";
      const t4 = "2026-10-09T00:00:04.000Z";
      const t5 = "2026-10-09T00:00:05.000Z";
      yield* sql`
        INSERT INTO projection_folders (
          folder_id, title, scripts_json, created_at, updated_at, space_id
        ) VALUES ('folder-1', 'Folder', '[]', ${now}, ${now}, 'space-1')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, created_at, updated_at,
          model_selection_json, connection_id
        ) VALUES (
          'thread-1', 'folder-1', 'Hello', ${now}, ${now},
          '{"provider":"codex","model":"gpt-5.5"}', 'conn-1'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('msg-user', 'thread-1', 'user', 'please build the thing', 0, ${t1}, ${t1}),
          ('msg-assistant', 'thread-1', 'assistant', 'building it now', 0, ${t2}, ${t2})
      `;
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, provider, item_type,
          title, status, activity_json, started_at, last_source_event_id, updated_at,
          presentation_sequence
        ) VALUES (
          'op-1', 'provider-op-1', 'thread-1', 'codex', 'command_execution',
          'Ran command', 'completed', '{"summary":"Ran command","payload":{"command":"ls"}}',
          ${t3}, 'evt-1', ${t3}, 3
        )
      `;
      yield* sql`
        INSERT INTO notices (
          notice_id, thread_id, kind, tone, summary, detail_json, created_at,
          presentation_sequence
        ) VALUES (
          'notice-1', 'thread-1', 'runtime.warning', 'warning', 'A warning',
          '{"detail":"be careful"}', ${t4}, 4
        )
      `;
      yield* sql`
        INSERT INTO projection_pending_interactions (
          interaction_kind, request_id, thread_id, status, created_at, resolved_at
        ) VALUES (
          'userInput', 'req-1', 'thread-1', 'confirmed', ${t5}, ${t5}
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES (
          'act-question', 'thread-1', 'info', 'user-input.requested', 'Which database?',
          '{"requestId":"req-1"}', ${t5}, 5
        )
      `;

      yield* runMigrations();

      const threads = yield* sql<{
        readonly id: string;
        readonly spaceId: string;
        readonly provider: string;
        readonly model: string;
        readonly state: string;
      }>`
        SELECT id, space_id AS "spaceId", provider, model, state FROM threads
      `;
      assert.deepStrictEqual(threads, [
        { id: "thread-1", spaceId: "space-1", provider: "codex", model: "gpt-5.5", state: "idle" },
      ]);

      const items = yield* sql<{
        readonly seq: number;
        readonly sourceId: string;
        readonly kind: string;
        readonly status: string;
        readonly text: string | null;
      }>`
        SELECT seq, source_id AS "sourceId", kind, status, text
        FROM thread_items WHERE thread_id = 'thread-1' ORDER BY seq
      `;
      assert.deepStrictEqual(items, [
        {
          seq: 1,
          sourceId: "msg-user",
          kind: "user",
          status: "sent",
          text: "please build the thing",
        },
        {
          seq: 2,
          sourceId: "msg-assistant",
          kind: "text",
          status: "done",
          text: "building it now",
        },
        { seq: 3, sourceId: "provider-op-1", kind: "tool", status: "done", text: "Ran command" },
        { seq: 4, sourceId: "notice-1", kind: "notice", status: "done", text: "A warning" },
        {
          seq: 5,
          sourceId: "question:req-1",
          kind: "question",
          status: "answered",
          text: "Which database?",
        },
      ]);

      const search = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_items_search
        WHERE thread_items_search MATCH 'building'
      `;
      assert.equal(search[0]?.count, 1);
    }),
  ),
);

it.effect("unwraps an OpenCode <task_result> into plain result text", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 175 });
      const now = "2026-10-09T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, created_at, updated_at, model_selection_json
        ) VALUES ('thread-task', 'folder-x', 'T', ${now}, ${now}, '{"provider":"opencode","model":"m"}')
      `;
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, provider, item_type,
          title, status, activity_json, started_at, last_source_event_id, updated_at,
          presentation_sequence
        ) VALUES (
          'op-task', 'provider-op-task', 'thread-task', 'opencode', 'task',
          'task', 'completed',
          '<task id="x"><task_result>\nPlain result\n</task_result></task>',
          ${now}, 'evt', ${now}, 1
        )
      `;
      yield* runMigrations();
      const rows = yield* sql<{ readonly text: string }>`
        SELECT text FROM thread_items WHERE thread_id = 'thread-task'
      `;
      assert.deepStrictEqual(rows, [{ text: "Plain result" }]);
    }),
  ),
);

it.effect("groups tool activities by the web's tool-call identity, beside operations", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 175 });
      const now = "2026-10-09T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, created_at, updated_at, model_selection_json
        ) VALUES ('thread-tools', 'folder-x', 'T', ${now}, ${now}, '{"provider":"claudeAgent","model":"m"}')
      `;
      // Two lifecycle rows for one call, plus a second call, plus an operation
      // whose provider_operation_id is disjoint from the activity identities.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES
          ('a1', 'thread-tools', 'tool', 'tool.started', 'Bash',
           '{"title":"Bash","status":"inProgress","data":{"toolCallId":"call_one"}}',
           '2026-10-09T00:00:01.000Z', 1),
          ('a2', 'thread-tools', 'tool', 'tool.completed', 'Bash',
           '{"title":"Bash","status":"completed","data":{"toolCallId":"call_one"}}',
           '2026-10-09T00:00:02.000Z', 2),
          ('a3', 'thread-tools', 'tool', 'tool.completed', 'Read',
           '{"title":"Read","status":"completed","data":{"toolUseId":"toolu_two"}}',
           '2026-10-09T00:00:03.000Z', 3)
      `;
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, provider, item_type,
          title, status, activity_json, started_at, last_source_event_id, updated_at,
          presentation_sequence
        ) VALUES (
          'op-x', 'exec-x', 'thread-tools', 'codex', 'command_execution',
          'Ran command', 'completed', '{"summary":"Ran command"}',
          '2026-10-09T00:00:04.000Z', 'evt-x', '2026-10-09T00:00:04.000Z', 4
        )
      `;
      yield* runMigrations();
      const rows = yield* sql<{
        readonly sourceId: string;
        readonly kind: string;
        readonly status: string;
        readonly text: string;
      }>`
        SELECT source_id AS "sourceId", kind, status, text FROM thread_items
        WHERE thread_id = 'thread-tools' ORDER BY seq
      `;
      assert.deepStrictEqual(rows, [
        { sourceId: "call_one", kind: "tool", status: "done", text: "Bash" },
        { sourceId: "toolu_two", kind: "tool", status: "done", text: "Read" },
        { sourceId: "exec-x", kind: "tool", status: "done", text: "Ran command" },
      ]);
    }),
  ),
);

it.effect("collapses a call present in both sources to one item", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 175 });
      const now = "2026-10-09T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, created_at, updated_at, model_selection_json
        ) VALUES ('thread-overlap', 'folder-x', 'T', ${now}, ${now}, '{"provider":"codex","model":"m"}')
      `;
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, provider, item_type,
          title, status, activity_json, started_at, last_source_event_id, updated_at,
          presentation_sequence
        ) VALUES (
          'op-shared', 'shared-id', 'thread-overlap', 'codex', 'command_execution',
          'From operation', 'completed', '{"summary":"From operation"}',
          '2026-10-09T00:00:02.000Z', 'evt-s', '2026-10-09T00:00:02.000Z', 2
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence
        ) VALUES (
          'act-shared', 'thread-overlap', 'tool', 'tool.completed', 'From activity',
          '{"title":"From activity","status":"completed","data":{"toolCallId":"shared-id"}}',
          '2026-10-09T00:00:01.000Z', 1
        )
      `;
      yield* runMigrations();
      const rows = yield* sql<{ readonly sourceId: string; readonly text: string }>`
        SELECT source_id AS "sourceId", text FROM thread_items
        WHERE thread_id = 'thread-overlap' AND kind = 'tool'
      `;
      // One identity, one item; the later operations row wins the tie-break.
      assert.deepStrictEqual(rows, [{ sourceId: "shared-id", text: "From operation" }]);
    }),
  ),
);

it.effect("rolls the backfill back when it fails, leaving the source intact", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 175 });
      const now = "2026-10-09T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, folder_id, title, created_at, updated_at, model_selection_json
        ) VALUES ('thread-bad', 'folder-bad', 'Bad', ${now}, ${now}, '{"provider":"codex","model":"m"}')
      `;
      // Malformed attachments JSON makes the message backfill's json() throw,
      // so migration 176 fails after its DDL. SQLite DDL and DML in the
      // migrator's transaction must roll back together.
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at,
          attachments_json
        ) VALUES ('msg-bad', 'thread-bad', 'user', 'hi', 0, ${now}, ${now}, '{not json')
      `;

      const result = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(result));

      const rolledBack = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'threads'
      `;
      assert.equal(rolledBack[0]?.count, 0);
      const source = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages WHERE thread_id = 'thread-bad'
      `;
      assert.equal(source[0]?.count, 1);
    }),
  ),
);

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  answerQuestion,
  createThread,
  makeThreadPublisher,
  setThreadArchived,
  upsertThreadItem,
} from "./threadStore.ts";
import { THREAD_ITEM_DATA_LIMIT_BYTES } from "./threadItemData.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const baseThread = {
  id: "thread-1",
  spaceId: "space-1",
  title: "Hello",
  provider: "codex",
  model: "gpt-5.5",
  runtimeMode: "full-access",
  createdBy: "user" as const,
  createdAt: "2026-10-09T00:00:00.000Z",
};

it.effect("createThread is idempotent on the client-chosen id", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* createThread(baseThread);
      yield* createThread({ ...baseThread, title: "Changed" });
      const rows = yield* sql<{ readonly id: string; readonly title: string }>`
        SELECT id, title FROM threads
      `;
      assert.deepStrictEqual(rows, [{ id: "thread-1", title: "Hello" }]);
    }),
  ),
);

it.effect("upsertThreadItem assigns seq once and updates in place", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* createThread(baseThread);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "msg-1",
        kind: "user",
        status: "sent",
        text: "first",
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "msg-2",
        kind: "text",
        status: "streaming",
        text: "partial",
        createdAt: "2026-10-09T00:00:02.000Z",
        updatedAt: "2026-10-09T00:00:02.000Z",
      });
      // Same source id: update in place, seq unchanged.
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "msg-2",
        kind: "text",
        status: "done",
        text: "complete",
        createdAt: "2026-10-09T00:00:02.000Z",
        updatedAt: "2026-10-09T00:00:03.000Z",
      });
      const rows = yield* sql<{
        readonly seq: number;
        readonly sourceId: string;
        readonly status: string;
        readonly text: string;
      }>`
        SELECT seq, source_id AS "sourceId", status, text FROM thread_items ORDER BY seq
      `;
      assert.deepStrictEqual(rows, [
        { seq: 1, sourceId: "msg-1", status: "sent", text: "first" },
        { seq: 2, sourceId: "msg-2", status: "done", text: "complete" },
      ]);

      // 2.1 write rule: the thread rollups move in the same write as the item.
      const rollups = yield* sql<{
        readonly lastActivityAt: string;
        readonly lastMessagePreview: string;
        readonly lastUserMessageAt: string;
        readonly openQuestionCount: number;
      }>`
        SELECT last_activity_at AS "lastActivityAt",
               last_message_preview AS "lastMessagePreview",
               last_user_message_at AS "lastUserMessageAt",
               open_question_count AS "openQuestionCount"
        FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(rollups, [
        {
          lastActivityAt: "2026-10-09T00:00:03.000Z",
          lastMessagePreview: "complete",
          lastUserMessageAt: "2026-10-09T00:00:01.000Z",
          openQuestionCount: 0,
        },
      ]);
    }),
  ),
);

it.effect("upsertThreadItem maintains open_question_count from question items", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* createThread(baseThread);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "q-1",
        kind: "question",
        status: "open",
        text: "Which database?",
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "q-2",
        kind: "question",
        status: "open",
        text: "Which port?",
        createdAt: "2026-10-09T00:00:02.000Z",
        updatedAt: "2026-10-09T00:00:02.000Z",
      });
      const open = yield* sql<{ readonly count: number }>`
        SELECT open_question_count AS count FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(open, [{ count: 2 }]);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "q-1",
        kind: "question",
        status: "answered",
        text: "Which database?",
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:03.000Z",
      });
      const afterAnswer = yield* sql<{ readonly count: number }>`
        SELECT open_question_count AS count FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(afterAnswer, [{ count: 1 }]);
    }),
  ),
);

it.effect("stores last_message_preview unchanged (no fixed truncation)", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* createThread(baseThread);
      const longText = "x".repeat(500);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "msg-long",
        kind: "user",
        status: "sent",
        text: longText,
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      const rows = yield* sql<{ readonly preview: string }>`
        SELECT last_message_preview AS preview FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(rows, [{ preview: longText }]);
    }),
  ),
);

it.effect("archive and answer are plain idempotent updates", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* createThread(baseThread);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "question:req-1",
        kind: "question",
        status: "open",
        text: "Which?",
        data: '{"requestId":"req-1"}',
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      yield* setThreadArchived("thread-1", "2026-10-09T00:01:00.000Z");
      yield* setThreadArchived("thread-1", "2026-10-09T00:01:00.000Z");
      yield* answerQuestion(
        "thread-1",
        "question:req-1",
        '{"answer":"A"}',
        "2026-10-09T00:02:00.000Z",
      );

      const threads = yield* sql<{ readonly archivedAt: string }>`
        SELECT archived_at AS "archivedAt" FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(threads, [{ archivedAt: "2026-10-09T00:01:00.000Z" }]);
      const items = yield* sql<{ readonly status: string; readonly data: string }>`
        SELECT status, data FROM thread_items WHERE source_id = 'question:req-1'
      `;
      assert.deepStrictEqual(items, [{ status: "answered", data: '{"answer":"A"}' }]);
    }),
  ),
);

it.effect("caps oversized item data at the shared 64 KB limit", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* createThread(baseThread);
      const big = "y".repeat(THREAD_ITEM_DATA_LIMIT_BYTES + 5);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "tool-big",
        kind: "tool",
        status: "done",
        data: big,
        createdAt: "2026-10-09T00:00:01.000Z",
        updatedAt: "2026-10-09T00:00:01.000Z",
      });
      const rows = yield* sql<{ readonly data: string }>`
        SELECT data FROM thread_items WHERE source_id = 'tool-big'
      `;
      const parsed = JSON.parse(rows[0]!.data) as {
        readonly truncated: boolean;
        readonly originalBytes: number;
        readonly preview: string;
      };
      assert.equal(parsed.truncated, true);
      assert.equal(parsed.originalBytes, big.length);
      assert.equal(parsed.preview.length, THREAD_ITEM_DATA_LIMIT_BYTES);
    }),
  ),
);

it("publishes per-thread changes and stops after unsubscribe", () => {
  const publisher = makeThreadPublisher();
  const seen: string[] = [];
  const unsubscribe = publisher.subscribe("thread-1", (change) => seen.push(change.threadId));
  publisher.publish({ threadId: "thread-1" });
  publisher.publish({ threadId: "thread-2" });
  unsubscribe();
  publisher.publish({ threadId: "thread-1" });
  assert.deepStrictEqual(seen, ["thread-1"]);
});

import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { observePublisher } from "./threadPublisherTestHelpers.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  answerQuestion,
  createThread,
  makeThreadPublisher,
  moveSidebarItem,
  moveFolder,
  moveSpace,
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
  folderId: "core-test-folder",
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
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
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
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "msg-1",
        kind: "user",
        status: "sent",
        text: "first",
        data: JSON.stringify({ origin: { _tag: "user" }, attachments: [] }),
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
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
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
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      const longText = "x".repeat(500);
      yield* upsertThreadItem({
        threadId: "thread-1",
        sourceId: "msg-long",
        kind: "user",
        status: "sent",
        text: longText,
        data: JSON.stringify({ origin: { _tag: "user" }, attachments: [] }),
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
it.effect("moveSidebarItem renumbers its folder siblings in one transaction", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_folders (folder_id, title, space_id, created_at, updated_at)
        VALUES ('folder-1', 'Folder', 'space-1', ${baseThread.createdAt}, ${baseThread.createdAt})`;
      for (const [id, createdAt] of [
        ["a", "2026-10-09T00:00:03.000Z"],
        ["b", "2026-10-09T00:00:02.000Z"],
        ["c", "2026-10-09T00:00:01.000Z"],
      ] as const) {
        yield* createThread({ ...baseThread, id, createdAt, folderId: "folder-1" });
      }
      // Default order is newest first: a, b, c. Move a after c.
      const changed = yield* moveSidebarItem({
        threadId: "a",
        folderId: "folder-1",
        position: { type: "after", itemId: "c" },
        updatedAt: "2026-10-09T00:00:09.000Z",
      });
      assert.deepStrictEqual(changed.toSorted(), ["a", "c"]);
      const rows = yield* sql<{ readonly id: string; readonly order: number }>`
        SELECT id, COALESCE(sidebar_sort_order, 0) AS "order" FROM threads ORDER BY "order"
      `;
      assert.deepStrictEqual(rows, [
        { id: "b", order: 0 },
        { id: "c", order: 1 },
        { id: "a", order: 2 },
      ]);
      // Repeating the same layout writes nothing.
      const again = yield* moveSidebarItem({
        threadId: "a",
        folderId: "folder-1",
        position: { type: "after", itemId: "c" },
        updatedAt: "2026-10-09T00:00:10.000Z",
      });
      assert.deepStrictEqual(again, []);
    }),
  ),
);

it.effect("archive and answer are plain idempotent updates", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
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
      yield* setThreadArchived(
        "thread-1",
        "2026-10-09T00:01:00.000Z",
        "2026-10-09T00:01:00.000Z",
        null,
      );
      yield* setThreadArchived(
        "thread-1",
        "2026-10-09T00:01:00.000Z",
        "2026-10-09T00:01:00.000Z",
        null,
      );
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
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
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

it.effect("publishes per-thread changes and stops after unsubscribe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const publisher = makeThreadPublisher();
      const seen: string[] = [];
      const received = yield* Deferred.make<void>();
      const unsubscribe = yield* observePublisher(publisher.threadChanges, (change) => {
        if (change.threadId === "thread-1") {
          seen.push(change.threadId);
          Effect.runFork(Deferred.succeed(received, undefined));
        }
      });
      publisher.publish({ threadId: "thread-1" });
      publisher.publish({ threadId: "thread-2" });
      yield* Deferred.await(received);
      unsubscribe();
      publisher.publish({ threadId: "thread-1" });
      assert.deepStrictEqual(seen, ["thread-1"]);
    }),
  ),
);

it.effect("moveFolder renumbers destination siblings and repeats without writes", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
          VALUES ('source', 'Source', '', 0, ${baseThread.createdAt}, ${baseThread.createdAt}),
          ('destination', 'Destination', '', 1, ${baseThread.createdAt}, ${baseThread.createdAt})`;
      for (const [id, spaceId, order] of [
        ["a", "source", 0],
        ["b", "destination", 0],
        ["c", "destination", 1],
      ] as const) {
        yield* sql`INSERT INTO projection_folders (folder_id, title, workspace_root, space_id,
        sidebar_sort_order, created_at, updated_at) VALUES (${id}, ${id}, NULL, ${spaceId},
        ${order}, ${baseThread.createdAt}, ${baseThread.createdAt})`;
      }
      const input = {
        folderId: "a",
        spaceId: "destination",
        position: { type: "before", itemId: "c" } as const,
        updatedAt: "2026-10-09T00:00:09.000Z",
      };
      const changed = yield* moveFolder(input);
      assert.deepStrictEqual(changed, { folderIds: ["a", "c"], threadIds: [] });
      const repeat = yield* moveFolder({ ...input, updatedAt: "2026-10-09T00:00:10.000Z" });
      assert.deepStrictEqual(repeat, { folderIds: [], threadIds: [] });
      const rows = yield* sql<{
        readonly id: string;
        readonly order: number;
        readonly updatedAt: string;
      }>`
      SELECT folder_id AS id, sidebar_sort_order AS "order", updated_at AS "updatedAt"
      FROM projection_folders ORDER BY sidebar_sort_order`;
      assert.deepStrictEqual(rows, [
        { id: "b", order: 0, updatedAt: baseThread.createdAt },
        { id: "a", order: 1, updatedAt: input.updatedAt },
        { id: "c", order: 2, updatedAt: input.updatedAt },
      ]);
    }),
  ),
);

it.effect("moveSpace renumbers active siblings and repeats without writes", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      for (const [id, order] of [
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ] as const) {
        yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
        VALUES (${id}, ${id}, '', ${order}, ${baseThread.createdAt}, ${baseThread.createdAt})`;
      }
      const input = {
        spaceId: "a",
        position: { type: "after", itemId: "c" } as const,
        updatedAt: "2026-10-09T00:00:09.000Z",
      };
      const changed = yield* moveSpace(input);
      assert.deepStrictEqual(changed, ["b", "c", "a"]);
      const repeat = yield* moveSpace({ ...input, updatedAt: "2026-10-09T00:00:10.000Z" });
      assert.deepStrictEqual(repeat, []);
      const rows = yield* sql<{
        readonly id: string;
        readonly order: number;
        readonly updatedAt: string;
      }>`
      SELECT space_id AS id, sort_order AS "order", updated_at AS "updatedAt"
      FROM projection_spaces ORDER BY sort_order`;
      assert.deepStrictEqual(rows, [
        { id: "b", order: 0, updatedAt: input.updatedAt },
        { id: "c", order: 1, updatedAt: input.updatedAt },
        { id: "a", order: 2, updatedAt: input.updatedAt },
      ]);
    }),
  ),
);

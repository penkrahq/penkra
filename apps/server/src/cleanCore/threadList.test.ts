import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { assert, it } from "@effect/vitest";
import { FolderId, SpaceId, ThreadId, TurnId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { listThreads, findThread, listRunningThreads } from "./threadList.ts";
import { createThread, makeThreadPublisher, upsertThreadItem } from "./threadStore.ts";
import { applyProviderEvent } from "./providerStreamConsumer.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("sidebar pages exclude archived history before applying the limit and cursor", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const spaceId = SpaceId.make("archive-heavy-space");
      const folderId = FolderId.make("archive-heavy-folder");
      yield* seedThreadFolderFixture(folderId, spaceId);
      for (let i = 0; i < 103; i++) {
        yield* createThread({
          id: "archive-heavy-" + i.toString().padStart(3, "0"),
          spaceId,
          folderId,
          title: "Member",
          provider: "codex",
          model: "model",
          runtimeMode: "full-access",
          createdBy: "user",
          sidebarSortOrder: i,
          createdAt: "2026-10-13T00:00:00.000Z",
        });
      }
      yield* sql`UPDATE threads SET archived_at = '2026-10-13T00:00:01.000Z' WHERE sidebar_sort_order < 51`;
      yield* sql`UPDATE threads SET deleted_at = '2026-10-13T00:00:01.000Z' WHERE id = 'archive-heavy-102'`;
      const first = yield* listThreads({ spaceId, folderId });
      assert.lengthOf(first.threads, 50);
      assert.equal(first.threads[0]!.id, "archive-heavy-051");
      assert.equal(first.threads.at(-1)!.id, "archive-heavy-100");
      assert.isTrue(first.threads.every((thread) => thread.archivedAt === null));
      assert.isNotNull(first.nextCursor);
      const second = yield* listThreads({ spaceId, folderId, after: first.nextCursor });
      assert.deepStrictEqual(
        second.threads.map((thread) => thread.id),
        ["archive-heavy-101"],
      );
      assert.isNull(second.nextCursor);
      yield* sql`UPDATE threads SET archived_at = '2026-10-13T00:00:02.000Z' WHERE archived_at IS NULL`;
      const empty = yield* listThreads({ spaceId, folderId });
      assert.deepStrictEqual(empty.threads, []);
      assert.isNull(empty.nextCursor);
      assert.isNotNull(yield* findThread(ThreadId.make("archive-heavy-051")));
    }),
  ),
);

it.effect("lists every thread with the columns the web reads", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("list-folder", "space-1");
      yield* createThread({
        id: "thread-1",
        spaceId: SpaceId.make("space-1"),
        folderId: "list-folder",
        title: "Hello",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        createdBy: "agent",
        createdByThreadId: "parent-thread",
        sidebarSortOrder: 1,
        createdAt: "2026-10-09T00:00:00.000Z",
      });
      yield* createThread({
        id: "thread-2",
        spaceId: SpaceId.make("space-1"),
        folderId: "list-folder",
        title: "Second",
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        runtimeMode: "read-only",
        createdBy: "user",
        sidebarSortOrder: 0,
        createdAt: "2026-10-09T00:00:01.000Z",
      });

      const page = yield* listThreads({
        spaceId: SpaceId.make("space-1"),
        folderId: FolderId.make("list-folder"),
      });
      const threads = page.threads;
      assert.deepStrictEqual(
        threads.map((thread) => thread.id),
        ["thread-2", "thread-1"],
      );
      assert.isNull(page.nextCursor);
      const first = threads.find((thread) => thread.id === "thread-1");
      assert.equal(first?.runtimeMode, "full-access");
      assert.equal(first?.createdBy, "agent");
      assert.equal(first?.createdByThreadId, "parent-thread");
      assert.equal(first?.openQuestionCount, 0);
      const second = threads.find((thread) => thread.id === "thread-2");
      assert.equal(second?.createdBy, "user");
      assert.equal(second?.createdByThreadId, null);
      assert.equal(second?.runtimeMode, "read-only");

      // Keyset pagination: one row per page, cursor advances.
      const firstPage = yield* listThreads({
        spaceId: SpaceId.make("space-1"),
        folderId: FolderId.make("list-folder"),
        limit: 1,
      });
      assert.deepStrictEqual(
        firstPage.threads.map((thread) => thread.id),
        ["thread-2"],
      );
      assert.isNotNull(firstPage.nextCursor);
      const secondPage = yield* listThreads({
        spaceId: SpaceId.make("space-1"),
        folderId: FolderId.make("list-folder"),
        limit: 1,
        after: firstPage.nextCursor,
      });
      assert.deepStrictEqual(
        secondPage.threads.map((thread) => thread.id),
        ["thread-1"],
      );
      assert.isNull(secondPage.nextCursor);
    }),
  ),
);

it.effect("pages folder members in sidebar order and excludes archived and deleted rows", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const folderId = FolderId.make("folder-list");
      yield* sql`INSERT INTO projection_folders (folder_id, kind, space_id, title, workspace_root, created_at, updated_at) VALUES (${folderId}, 'project', 'space', 'Folder', NULL, '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`;
      for (let i = 0; i < 53; i++) {
        yield* createThread({
          id: "folder-thread-" + i.toString().padStart(2, "0"),
          spaceId: SpaceId.make("space"),
          folderId,
          sidebarSortOrder: i,
          title: "Member",
          provider: "codex",
          model: "gpt-5.5",
          runtimeMode: "full-access",
          createdBy: "user",
          createdAt: "2026-10-10T00:00:00.000Z",
        });
      }
      yield* sql`UPDATE threads SET deleted_at = '2026-10-10T00:00:01.000Z' WHERE id = 'folder-thread-51'`;
      yield* sql`UPDATE threads SET archived_at = '2026-10-10T00:00:01.000Z' WHERE id = 'folder-thread-52'`;
      const first = yield* listThreads({
        spaceId: SpaceId.make("space"),
        folderId,
        after: null,
      });
      assert.lengthOf(first.threads, 50);
      assert.equal(first.threads[0]!.id, "folder-thread-00");
      assert.equal(first.threads.at(-1)!.id, "folder-thread-49");
      assert.isNotNull(first.nextCursor);
      const next = yield* listThreads({
        spaceId: SpaceId.make("space"),
        folderId,
        after: first.nextCursor,
      });
      assert.deepStrictEqual(
        next.threads.map((row) => row.id),
        ["folder-thread-50"],
      );
      assert.isNull(next.nextCursor);
      const empty = yield* listThreads({
        spaceId: SpaceId.make("space"),
        folderId: FolderId.make("empty-folder"),
        after: null,
      });
      assert.deepStrictEqual(empty.threads, []);
      assert.isNull(empty.nextCursor);
    }),
  ),
);

it.effect("reads the newest canonical turn from the indexed sidebar and thread row", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("list-folder", "space-1");
      yield* createThread({
        id: "thread-1",
        spaceId: "space-1",
        folderId: "list-folder",
        title: "Hello",
        provider: "codex",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: "2026-10-12T00:00:00.000Z",
      });
      const publisher = makeThreadPublisher();
      assert.isNull((yield* findThread(ThreadId.make("thread-1")))!.latestTurn);
      yield* applyProviderEvent(publisher, {
        type: "turn.started",
        threadId: "thread-1",
        turnId: "native",
        at: "2026-10-12T00:00:01.000Z",
      });
      assert.equal((yield* listRunningThreads())[0]!.latestTurn!.status, "running");
      yield* applyProviderEvent(publisher, {
        type: "turn.ended",
        threadId: "thread-1",
        turnId: "native",
        state: "completed",
        at: "2026-10-12T00:00:06.000Z",
      });
      const expected = {
        turnId: TurnId.make("native"),
        status: "done" as const,
        startedAt: "2026-10-12T00:00:01.000Z",
        endedAt: "2026-10-12T00:00:06.000Z",
      };
      assert.deepStrictEqual((yield* findThread(ThreadId.make("thread-1")))!.latestTurn, expected);
      assert.deepStrictEqual(
        (yield* listThreads({
          spaceId: SpaceId.make("space-1"),
          folderId: FolderId.make("list-folder"),
        })).threads[0]!.latestTurn,
        expected,
      );
    }),
  ),
);

it.effect("reads only the newest open canonical question and excludes answered questions", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("questions-folder", "space");
      const at = "2020-01-01T00:00:00.000Z";
      yield* createThread({
        id: "questions-thread",
        spaceId: "space",
        folderId: "questions-folder",
        title: "Questions",
        provider: "codex",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: at,
      });
      for (const id of ["first", "second"])
        yield* upsertThreadItem({
          threadId: "questions-thread",
          sourceId: id,
          kind: "question",
          status: "open",
          text: id,
          createdAt: at,
          updatedAt: at,
        });
      assert.deepStrictEqual(
        (yield* findThread(ThreadId.make("questions-thread")))?.latestOpenQuestion,
        { id: "second", summary: "second", createdAt: at },
      );
      yield* upsertThreadItem({
        threadId: "questions-thread",
        sourceId: "second",
        kind: "question",
        status: "answered",
        createdAt: at,
        updatedAt: at,
      });
      assert.equal(
        (yield* findThread(ThreadId.make("questions-thread")))?.latestOpenQuestion?.id,
        "first",
      );
    }),
  ),
);

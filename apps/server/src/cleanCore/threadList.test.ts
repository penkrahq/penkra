import { assert, it } from "@effect/vitest";
import { SpaceId, ThreadDeckId, ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { listThreads, listDeckThreads } from "./threadList.ts";
import { createThread } from "./threadStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";

const withDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

it.effect("lists every thread with the columns the web reads", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* createThread({
        id: "thread-1",
        spaceId: SpaceId.makeUnsafe("space-1"),
        title: "Hello",
        provider: "codex",
        model: "gpt-5.5",
        runtimeMode: "full-access",
        workingDirectory: "/repo",
        createdBy: "agent",
        createdByThreadId: "parent-thread",
        deckId: "deck:thread-1",
        deckSortOrder: 2,
        sidebarSortOrder: 1,
        isPinned: 1,
        createdAt: "2026-10-09T00:00:00.000Z",
      });
      yield* createThread({
        id: "thread-2",
        spaceId: SpaceId.makeUnsafe("space-1"),
        title: "Second",
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        runtimeMode: "read-only",
        createdBy: "user",
        sidebarSortOrder: 0,
        createdAt: "2026-10-09T00:00:01.000Z",
      });

      const page = yield* listThreads({ spaceId: SpaceId.makeUnsafe("space-1"), folderId: null });
      const threads = page.threads;
      assert.deepStrictEqual(
        threads.map((thread) => thread.id),
        ["thread-1", "thread-2"],
      );
      assert.isNull(page.nextCursor);
      const first = threads.find((thread) => thread.id === "thread-1");
      assert.equal(first?.runtimeMode, "full-access");
      assert.equal(first?.workingDirectory, "/repo");
      assert.equal(first?.createdBy, "agent");
      assert.equal(first?.createdByThreadId, "parent-thread");
      assert.equal(first?.deckId, "deck:thread-1");
      assert.equal(first?.deckSortOrder, 2);
      assert.equal(first?.isPinned, 1);
      assert.equal(first?.openQuestionCount, 0);
      const second = threads.find((thread) => thread.id === "thread-2");
      assert.equal(second?.createdBy, "user");
      assert.equal(second?.createdByThreadId, null);
      assert.equal(second?.runtimeMode, "read-only");

      // Keyset pagination: one row per page, cursor advances.
      const firstPage = yield* listThreads({
        spaceId: SpaceId.makeUnsafe("space-1"),
        folderId: null,
        limit: 1,
      });
      assert.deepStrictEqual(
        firstPage.threads.map((thread) => thread.id),
        ["thread-1"],
      );
      assert.isNotNull(firstPage.nextCursor);
      const secondPage = yield* listThreads({
        spaceId: SpaceId.makeUnsafe("space-1"),
        folderId: null,
        limit: 1,
        after: firstPage.nextCursor,
      });
      assert.deepStrictEqual(
        secondPage.threads.map((thread) => thread.id),
        ["thread-2"],
      );
      assert.isNull(secondPage.nextCursor);
    }),
  ),
);

it.effect(
  "pages deck members in canonical order with the deck index and excludes deleted rows",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const deckId = ThreadDeckId.makeUnsafe("deck");
        for (let i = 0; i < 52; i++) {
          yield* createThread({
            id: "deck-thread-" + i.toString().padStart(2, "0"),
            spaceId: SpaceId.makeUnsafe("space"),
            title: "Member",
            provider: "codex",
            model: "gpt-5.5",
            runtimeMode: "full-access",
            createdBy: "user",
            deckId,
            deckSortOrder: Math.floor(i / 2),
            createdAt: "2026-10-10T00:00:00.000Z",
          });
        }
        yield* sql`UPDATE threads SET deleted_at = '2026-10-10T00:00:01.000Z' WHERE id = 'deck-thread-51'`;
        const first = yield* listDeckThreads({ deckId, after: null });
        assert.lengthOf(first.threads, 50);
        assert.equal(first.threads[0]!.id, "deck-thread-00");
        assert.equal(first.threads.at(-1)!.id, "deck-thread-49");
        assert.isNotNull(first.nextCursor);
        const next = yield* listDeckThreads({ deckId, after: first.nextCursor });
        assert.deepStrictEqual(
          next.threads.map((row) => row.id),
          ["deck-thread-50"],
        );
        assert.isNull(next.nextCursor);
        const empty = yield* listDeckThreads({
          deckId: ThreadDeckId.makeUnsafe("empty"),
          after: null,
        });
        assert.deepStrictEqual(empty.threads, []);
        assert.isNull(empty.nextCursor);
        const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT id FROM threads
      WHERE deck_id = ${deckId} AND deleted_at IS NULL AND (deck_sort_order > 24 OR
        (deck_sort_order = 24 AND id > ${ThreadId.makeUnsafe("deck-thread-49")}))
      ORDER BY deck_sort_order, id LIMIT 50`;
        assert.isTrue(plan.some((row) => row.detail.includes("idx_threads_deck_order")));
        assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
      }),
    ),
);

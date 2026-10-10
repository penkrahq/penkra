import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { listThreads } from "./threadList.ts";
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
        spaceId: "space-1",
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
        spaceId: "space-1",
        title: "Second",
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        runtimeMode: "read-only",
        createdBy: "user",
        sidebarSortOrder: 0,
        createdAt: "2026-10-09T00:00:01.000Z",
      });

      const threads = yield* listThreads();
      assert.deepStrictEqual(
        threads.map((thread) => thread.id),
        ["thread-2", "thread-1"],
      );
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
    }),
  ),
);

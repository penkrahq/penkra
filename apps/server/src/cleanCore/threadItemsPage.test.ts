import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { listThreadItemsPage } from "./threadItemsPage.ts";
import { createThread, upsertThreadItem } from "./threadStore.ts";
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

it.effect("reads the newest 50 items, then pages older by seq cursor", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* Effect.forEach(
        Array.from({ length: 60 }, (_, i) => i + 1),
        (n) =>
          upsertThreadItem({
            threadId: "thread-1",
            sourceId: `m-${String(n).padStart(3, "0")}`,
            kind: "text",
            status: "done",
            text: `item ${n}`,
            createdAt: `2026-10-09T00:00:${String(n % 60).padStart(2, "0")}.000Z`,
            updatedAt: "2026-10-09T00:00:00.000Z",
          }),
        { discard: true },
      );

      const first = yield* listThreadItemsPage({ threadId: ThreadId.makeUnsafe("thread-1") });
      assert.equal(first.items.length, 50);
      assert.equal(first.items[0]?.seq, 60);
      assert.equal(first.items.at(-1)?.seq, 11);
      assert.equal(first.nextCursor, 11);

      const second = yield* listThreadItemsPage({
        threadId: ThreadId.makeUnsafe("thread-1"),
        beforeSeq: 11,
      });
      assert.equal(second.items.length, 10);
      assert.equal(second.items[0]?.seq, 10);
      assert.equal(second.items.at(-1)?.seq, 1);
      assert.isNull(second.nextCursor);
    }),
  ),
);

it.effect(
  "cold page reads exact turn timing even when its marker is beyond the page boundary",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedThreadFolderFixture("core-test-folder", "space-1");
        yield* createThread(baseThread);
        const startedAt = "2026-10-12T00:00:00.000Z";
        const endedAt = "2026-10-12T00:05:00.000Z";
        yield* upsertThreadItem({
          threadId: "thread-1",
          sourceId: "turn:long",
          turnId: "long",
          kind: "turn",
          status: "done",
          data: JSON.stringify({ startedAt, endedAt }),
          createdAt: startedAt,
          updatedAt: endedAt,
        });
        for (let n = 0; n < 60; n++)
          yield* upsertThreadItem({
            threadId: "thread-1",
            sourceId: `part-${n}`,
            turnId: "long",
            kind: "text",
            status: "done",
            text: `part ${n}`,
            createdAt: endedAt,
            updatedAt: endedAt,
          });
        const page = yield* listThreadItemsPage({ threadId: ThreadId.makeUnsafe("thread-1") });
        assert.equal(page.items.length, 50);
        assert.isFalse(page.items.some((item) => item.kind === "turn"));
        assert.deepStrictEqual(JSON.parse(page.turns.long!.data!), { startedAt, endedAt });
        assert.equal(Object.keys(page.turns).length, 1);
      }),
    ),
);

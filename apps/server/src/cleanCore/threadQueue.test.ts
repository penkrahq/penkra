import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { MessageId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { enqueueMessage, planSend, readThreadQueue } from "./threadQueue.ts";
import { createThread } from "./threadStore.ts";
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

it.effect("queue is a FIFO persisted on threads.queue", () =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      yield* createThread(baseThread);
      yield* enqueueMessage("thread-1", {
        messageId: MessageId.make("m1"),
        attachments: [],
        origin: { _tag: "user" as const },
        text: "first",
        queuedAt: "2026-10-09T00:00:01.000Z",
      });
      yield* enqueueMessage("thread-1", {
        messageId: MessageId.make("m2"),
        attachments: [],
        origin: { _tag: "user" as const },
        text: "second",
        queuedAt: "2026-10-09T00:00:02.000Z",
      });

      assert.deepStrictEqual(
        (yield* readThreadQueue("thread-1")).map((m) => m.messageId),
        ["m1", "m2"],
      );

      // The persisted column is a JSON array.
      const rows = yield* sql<{ readonly queue: string }>`
        SELECT queue FROM threads WHERE id = 'thread-1'
      `;
      assert.deepStrictEqual(
        JSON.parse(rows[0]!.queue).map((message: { messageId: string }) => message.messageId),
        ["m1", "m2"],
      );
    }),
  ),
);

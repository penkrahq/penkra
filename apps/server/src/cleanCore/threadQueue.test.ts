import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { MessageId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { enqueueMessage, planSend, readThreadQueue } from "./threadQueue.ts";
import { createThread, makeThreadPublisher, setThreadArchived, setThreadState } from "./threadStore.ts";
import { settleRunningThreadsOnStartup } from "./providerStreamConsumer.ts";
import { shouldResumeAfterRestart } from "./resumeThread.ts";
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

const restartAt = "2026-11-19T00:00:00.000Z";
const thread = (id: string) => ({
  id,
  spaceId: "space-1",
  folderId: "core-test-folder",
  title: id,
  provider: "codex",
  model: "gpt-5.5",
  runtimeMode: "full-access",
  createdBy: "user" as const,
  createdAt: restartAt,
});

const userItem = (threadId: string, seq: number, origin: "user" | "recovery") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_items(thread_id,seq,source_id,turn_id,kind,status,text,data,created_at,updated_at)
      VALUES (${threadId},${seq},${`user:${seq}`},NULL,'user','sent','hi',
        json_object('origin',json_object('_tag',${origin}),'attachments',json('[]')),${restartAt},${restartAt})`;
  });

it.effect("a restart returns the threads it cut off, and only the right ones resume", () =>
  withDb(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("core-test-folder", "space-1");
      for (const id of ["user-turn", "resume-turn", "archived", "idle"]) yield* createThread(thread(id));
      yield* userItem("user-turn", 1, "user");
      yield* userItem("resume-turn", 1, "user");
      yield* userItem("resume-turn", 2, "recovery");
      yield* userItem("archived", 1, "user");
      yield* setThreadArchived("archived", restartAt, restartAt, null);
      for (const id of ["user-turn", "resume-turn", "archived"]) yield* setThreadState(id, "running", "turn-1", null, restartAt);

      const cutOff = yield* settleRunningThreadsOnStartup(makeThreadPublisher(), restartAt);
      assert.deepStrictEqual([...cutOff].sort(), ["archived", "resume-turn", "user-turn"]);

      // A turn the user started continues; a cut-off automatic continuation
      // doesn't (no restart loop); archived threads stay put.
      assert.strictEqual(yield* shouldResumeAfterRestart("user-turn"), true);
      assert.strictEqual(yield* shouldResumeAfterRestart("resume-turn"), false);
      assert.strictEqual(yield* shouldResumeAfterRestart("archived"), false);
    }),
  ),
);

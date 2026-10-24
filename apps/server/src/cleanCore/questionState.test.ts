import { assert, it } from "@effect/vitest";
import { ThreadId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { seedThreadFolderFixture } from "./threadFixtures.ts";
import { findThread } from "./threadList.ts";
import {
  answerQuestion,
  createThread,
  settleRunningItems,
  upsertThreadItem,
} from "./threadStore.ts";

it.effect("question state follows answers and turn settlement without a stored counter", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* seedThreadFolderFixture("questions-folder", "questions-space");
    const threadId = ThreadId.make("questions-thread");
    const at = "2026-10-17T00:00:00.000Z";
    yield* createThread({
      id: threadId,
      spaceId: "questions-space",
      folderId: "questions-folder",
      title: "Questions",
      provider: "codex",
      model: "model",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: at,
    });
    for (const turnId of ["turn-a", "turn-b"]) {
      yield* upsertThreadItem({
        threadId,
        sourceId: `question:${turnId}`,
        turnId,
        kind: "question",
        status: "open",
        text: "Which option?",
        createdAt: at,
        updatedAt: at,
      });
    }
    assert.equal((yield* findThread(threadId))!.openQuestionCount, 2);
    yield* answerQuestion(threadId, "question:turn-a", "{}", at);
    assert.equal((yield* findThread(threadId))!.openQuestionCount, 1);
    yield* settleRunningItems(threadId, at, "turn-a");
    assert.equal((yield* findThread(threadId))!.openQuestionCount, 1);
    yield* settleRunningItems(threadId, at, "turn-b");
    assert.equal((yield* findThread(threadId))!.openQuestionCount, 0);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      status: string;
    }>`SELECT status FROM thread_items WHERE source_id='question:turn-b'`;
    assert.equal(rows[0]!.status, "cancelled");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

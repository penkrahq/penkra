import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient";
import { getMessageAdmission } from "./messageAdmission";
import { seedThreadFolderFixture } from "./threadFixtures";
import { createThread, upsertThreadItem } from "./threadStore";

it.effect("finds the exact admitted user item or queue entry, scoped to its thread", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* seedThreadFolderFixture("folder", "space");
    const at = "2026-10-27T00:00:00.000Z";
    yield* createThread({
      id: "thread",
      spaceId: "space",
      folderId: "folder",
      title: "Test",
      provider: "codex",
      model: "model",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: at,
    });
    assert.deepStrictEqual(
      yield* getMessageAdmission({ threadId: "thread", messageId: "message" }),
      { threadExists: true, present: false },
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE threads SET queue=${JSON.stringify([{ messageId: "message" }])} WHERE id='thread'`;
    assert.deepStrictEqual(
      yield* getMessageAdmission({ threadId: "thread", messageId: "message" }),
      { threadExists: true, present: true },
    );
    yield* sql`UPDATE threads SET queue='[]' WHERE id='thread'`;
    yield* upsertThreadItem({
      threadId: "thread",
      sourceId: "message",
      kind: "user",
      status: "sent",
      text: "hi",
      data: JSON.stringify({ origin: { _tag: "user" }, attachments: [] }),
      createdAt: at,
      updatedAt: at,
    });
    assert.deepStrictEqual(
      yield* getMessageAdmission({ threadId: "thread", messageId: "message" }),
      { threadExists: true, present: true },
    );
    assert.deepStrictEqual(
      yield* getMessageAdmission({ threadId: "missing", messageId: "message" }),
      { threadExists: false, present: false },
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

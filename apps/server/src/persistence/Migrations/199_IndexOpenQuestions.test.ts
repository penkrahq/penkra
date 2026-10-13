import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread, upsertThreadItem } from "../../cleanCore/threadStore.ts";
import indexOpenQuestions from "./199_IndexOpenQuestions.ts";

it.effect("indexes open questions without changing stored rows and rolls back on failure", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 198 });
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-10-12T00:00:00.000Z";
    yield* seedThreadFolderFixture("folder", "space");
    yield* createThread({
      id: "thread",
      folderId: "folder",
      spaceId: "space",
      title: "Keep",
      provider: "codex",
      model: "model",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: at,
    });
    yield* upsertThreadItem({
      threadId: "thread",
      sourceId: "question:keep",
      turnId: "keep",
      kind: "question",
      status: "open",
      data: JSON.stringify({ startedAt: at, endedAt: at }),
      createdAt: at,
      updatedAt: at,
    });
    const before = yield* sql`SELECT * FROM thread_items`;
    yield* Effect.flip(
      sql.withTransaction(
        indexOpenQuestions.pipe(Effect.andThen(Effect.fail(new Error("injected")))),
      ),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name='idx_thread_items_open_question'`,
      [],
    );
    yield* indexOpenQuestions;
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, before);
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT seq FROM thread_items WHERE thread_id='thread' AND kind='question' AND status='open' ORDER BY seq DESC LIMIT 1`;
    assert.isTrue(plan.some((row) => row.detail.includes("idx_thread_items_open_question")));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

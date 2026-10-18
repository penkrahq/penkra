import { seedHistoricalThreadItem } from "./historicalFolderFixture.ts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { seedHistoricalFolderFixture } from "./historicalFolderFixture.ts";
import { createThread } from "../../cleanCore/threadStore.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import removeDecision from "./194_RemoveApprovalDecisionColumn.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 193 });
  const at = "2026-10-11T00:00:00.000Z";
  yield* seedHistoricalFolderFixture({ folderId: "folder", spaceId: "space" });
  yield* createThread({
    id: "thread",
    folderId: "folder",
    spaceId: "space",
    title: "Keep",
    provider: "claudeAgent",
    model: "claude-sonnet-4-6",
    runtimeMode: "full-access",
    createdBy: "user",
    createdAt: at,
  });
  yield* seedHistoricalThreadItem({
    threadId: "thread",
    sourceId: "question",
    turnId: null,
    kind: "question",
    status: "open",
    text: "Choose",
    createdAt: at,
    updatedAt: at,
  });
  yield* sql`INSERT INTO projection_pending_interactions
    (interaction_kind, request_id, thread_id, lifecycle_generation, status, decision, created_at)
    VALUES ('userInput', 'question', 'thread', 'generation', 'pending', NULL, ${at}),
    ('approval', 'historical', 'thread', 'generation', 'confirmed', 'accept', ${at})`;
});
const interactionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT interaction_kind, request_id, thread_id, turn_id,
    lifecycle_generation, status, response_command_id, response_requested_at,
    created_at, resolved_at FROM projection_pending_interactions ORDER BY request_id`;
});

it.effect("drops the obsolete decision column and preserves interactions, threads and items", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const interactions = yield* interactionRows;
    const threads = yield* sql`SELECT * FROM threads`;
    const items = yield* sql`SELECT * FROM thread_items`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 195 }), [
      [194, "RemoveApprovalDecisionColumn"],
      [195, "RemoveFolderScripts"],
    ]);
    assert.deepStrictEqual(yield* interactionRows, interactions);
    assert.deepStrictEqual(yield* sql`SELECT * FROM threads`, threads);
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, items);
    const columns = yield* sql<{
      name: string;
    }>`PRAGMA table_info(projection_pending_interactions)`;
    assert.isFalse(columns.some((column) => column.name === "decision"));
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 195 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back the decision column drop and preserves its values on failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const rows = yield* sql`SELECT * FROM projection_pending_interactions ORDER BY request_id`;
    const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        removeDecision.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.equal(error.message, "injected failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM projection_pending_interactions ORDER BY request_id`,
      rows,
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`, schema);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

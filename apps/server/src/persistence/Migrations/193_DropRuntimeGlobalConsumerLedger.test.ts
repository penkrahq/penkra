import { seedHistoricalThreadItem } from "./historicalFolderFixture.ts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { seedHistoricalFolderFixture } from "./historicalFolderFixture.ts";
import { createThread } from "../../cleanCore/threadStore.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import dropGlobalConsumerLedger from "./193_DropRuntimeGlobalConsumerLedger.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 192 });
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
    sourceId: "message",
    turnId: null,
    kind: "text",
    status: "done",
    text: "Keep transcript",
    createdAt: at,
    updatedAt: at,
  });
  yield* sql`INSERT INTO provider_runtime_events
    (event_id, thread_id, event_type, event_json, persisted_at)
    VALUES ('event', 'thread', 'runtime.warning', '{}', ${at})`;
  yield* sql`INSERT INTO provider_runtime_thread_cursors
    (thread_id, last_acked_sequence, created_at, updated_at) VALUES ('thread', 1, ${at}, ${at})`;
  yield* sql`INSERT INTO provider_runtime_event_consumers
    (consumer_name, last_acked_sequence, created_at, updated_at)
    VALUES ('unused-consumer', 1, ${at}, ${at})`;
});

it.effect(
  "drops the global consumer ledger and preserves thread rows, items and live cursors",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const threads = yield* sql`SELECT * FROM threads`;
      const items = yield* sql`SELECT * FROM thread_items`;
      const events = yield* sql`SELECT * FROM provider_runtime_events`;
      const cursors = yield* sql`SELECT * FROM provider_runtime_thread_cursors`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 195 }), [
        [193, "DropRuntimeGlobalConsumerLedger"],
        [194, "RemoveApprovalDecisionColumn"],
        [195, "RemoveFolderScripts"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM threads`, threads);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, items);
      assert.deepStrictEqual(yield* sql`SELECT * FROM provider_runtime_events`, events);
      assert.deepStrictEqual(yield* sql`SELECT * FROM provider_runtime_thread_cursors`, cursors);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE sql LIKE '%provider_runtime_event_consumers%'`,
        [],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 195 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back the global consumer ledger drop on failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const rows = yield* sql`SELECT * FROM provider_runtime_event_consumers`;
    const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        dropGlobalConsumerLedger.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.equal(error.message, "injected failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM provider_runtime_event_consumers`, rows);
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`, schema);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

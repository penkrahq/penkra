import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createThread, upsertThreadItem } from "../../cleanCore/threadStore.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import dropRepairs from "./192_DropProviderDeliveryRepairs.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 191 });
  const at = "2026-10-11T00:00:00.000Z";
  yield* seedThreadFolderFixture("folder", "space");
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
  yield* upsertThreadItem({
    threadId: "thread",
    sourceId: "message",
    turnId: null,
    kind: "text",
    status: "done",
    text: "Keep transcript",
    createdAt: at,
    updatedAt: at,
  });
  yield* sql`INSERT INTO provider_intent_outbox (
    event_sequence, event_id, thread_id, lane_key, event_type, event_json, state, created_at, updated_at
  ) VALUES (1, 'intent', 'thread', 'thread', 'thread.turn-start-requested', '{}', 'dead', ${at}, ${at})`;
  yield* sql`INSERT INTO provider_intent_outbox_reconciliations (
    reconciliation_id, event_sequence, thread_id, previous_state, outcome, reconciled_by, reconciled_at
  ) VALUES ('repair', 1, 'thread', 'dead', 'abandon', 'operator', ${at})`;
});

it.effect(
  "drops the unused repair journal while preserving threads, items and the live outbox",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const threads = yield* sql`SELECT * FROM threads`;
      const items = yield* sql`SELECT * FROM thread_items`;
      const outbox = yield* sql`SELECT * FROM provider_intent_outbox`;
      assert.deepStrictEqual(yield* runMigrations(), [
        [192, "DropProviderDeliveryRepairs"],
        [193, "DropRuntimeGlobalConsumerLedger"],
        [194, "RemoveApprovalDecisionColumn"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM threads`, threads);
      assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, items);
      assert.deepStrictEqual(yield* sql`SELECT * FROM provider_intent_outbox`, outbox);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE sql LIKE '%provider_intent_outbox_reconciliations%'`,
        [],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back the repair journal drop on failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const rows = yield* sql`SELECT * FROM provider_intent_outbox_reconciliations`;
    const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        dropRepairs.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.equal(error.message, "injected failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM provider_intent_outbox_reconciliations`, rows);
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`, schema);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

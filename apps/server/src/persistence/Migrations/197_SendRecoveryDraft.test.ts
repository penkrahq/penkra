import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import addRecoveryDraft from "./197_SendRecoveryDraft.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread } from "../../cleanCore/threadStore.ts";

const seed = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 196 });
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
    createdAt: "2026-10-12T00:00:00.000Z",
  });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO thread_items (thread_id,seq,source_id,kind,status,text,created_at,updated_at)
    VALUES ('thread',1,'message','user','sent','Keep','2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z')`;
});
it.effect("adds admission storage and preserves sent items through the replacement migration", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql`SELECT thread_id,seq,source_id,text FROM thread_items`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 202 }), [
      [197, "SendRecoveryDraft"],
      [198, "IndexLatestTurn"],
      [199, "IndexOpenQuestions"],
      [200, "FailedSendPayload"],
      [201, "DropLegacyPipeline"],
      [202, "FoldProviderState"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT thread_id,seq,source_id,text FROM thread_items`,
      before,
    );
    assert.deepStrictEqual(yield* sql`SELECT send_payload,admission_plan FROM thread_items`, [
      { send_payload: null, admission_plan: null },
    ]);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
it.effect("rolls back the private recovery column on failure", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql`SELECT * FROM thread_items`;
    yield* Effect.flip(
      sql.withTransaction(
        addRecoveryDraft.pipe(Effect.andThen(Effect.fail(new Error("injected")))),
      ),
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items`, before);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(thread_items)`;
    assert.isFalse(
      columns.some(
        (column) => column.name === "recovery_draft" || column.name === "admission_plan",
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

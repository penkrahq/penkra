import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { seedThreadFolderFixture } from "../../cleanCore/threadFixtures.ts";
import { createThread } from "../../cleanCore/threadStore.ts";
import migrate from "./200_FailedSendPayload.ts";
const seed = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 199 });
  yield* seedThreadFolderFixture("folder", "space");
  const at = "2026-10-12T00:00:00.000Z";
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
  const sql = yield* SqlClient.SqlClient;
  for (const [seq, kind, status] of [
    [1, "user", "sent"],
    [2, "user", "sending"],
    [3, "user", "failed"],
    [4, "tool", "failed"],
  ] as const)
    yield* sql`INSERT INTO thread_items (thread_id,seq,source_id,kind,status,text,created_at,updated_at) VALUES ('thread',${seq},${String(seq)},${kind},${status},'Keep',${at},${at})`;
});
it.effect("preserves historical messages without resend payloads and drops only recovery", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(
      (yield* sql<{ seq: number }>`SELECT seq FROM thread_items ORDER BY seq`).map(
        (row) => row.seq,
      ),
      [1, 2, 3, 4],
    );
    const names = (yield* sql<{ name: string }>`PRAGMA table_info(thread_items)`).map(
      (row) => row.name,
    );
    assert.isFalse(names.includes("recovery_draft"));
    assert.isTrue(names.includes("send_payload"));
    assert.deepStrictEqual(yield* sql`SELECT id,title FROM threads`, [
      { id: "thread", title: "Keep" },
    ]);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
it.effect("rolls back column replacement and historical-state mapping on failure", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql`SELECT * FROM thread_items ORDER BY seq`;
    yield* Effect.flip(
      sql.withTransaction(migrate.pipe(Effect.andThen(Effect.fail(new Error("injected"))))),
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM thread_items ORDER BY seq`, before);
    const names = (yield* sql<{ name: string }>`PRAGMA table_info(thread_items)`).map(
      (row) => row.name,
    );
    assert.isTrue(names.includes("recovery_draft"));
    assert.isFalse(names.includes("send_payload"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { verifyCleanCoreBackfill } from "./verifyCleanCoreBackfill.ts";

const seedSource = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 175 });
  const now = "2026-10-11T00:00:00.000Z";
  yield* sql`INSERT INTO projection_folders(folder_id, title, workspace_root, scripts_json, space_id, created_at, updated_at)
    VALUES ('folder', 'Folder', '/repo', '[]', 'penkra-personal', ${now}, ${now})`;
  yield* sql`INSERT INTO projection_threads(thread_id, folder_id, title, runtime_mode, created_at, updated_at)
    VALUES ('thread', 'folder', 'Chat', 'full-access', ${now}, ${now})`;
  yield* sql`INSERT INTO projection_thread_messages(message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('user', 'thread', 'user', 'Question', 0, ${now}, ${now}),
           ('assistant', 'thread', 'assistant', 'Answer', 0, ${now}, ${now})`;
  yield* sql`INSERT INTO projection_pending_interactions(interaction_kind, request_id, thread_id, status, created_at)
    VALUES ('userInput', 'open', 'thread', 'pending', ${now}),
           ('userInput', 'answered', 'thread', 'confirmed', ${now})`;
});

it.effect("verifies every message and open question through the real migration path", () =>
  Effect.gen(function* () {
    yield* seedSource;
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    assert.deepStrictEqual(yield* sql`SELECT kind, status FROM thread_items ORDER BY source_id`, [
      { kind: "text", status: "done" },
      { kind: "question", status: "answered" },
      { kind: "question", status: "open" },
      { kind: "user", status: "sent" },
    ]);
    yield* verifyCleanCoreBackfill;
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("names the first thread with a message-count mismatch", () =>
  Effect.gen(function* () {
    yield* seedSource;
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM thread_items WHERE source_id = 'assistant'`;
    const failure = yield* Effect.flip(verifyCleanCoreBackfill);
    assert.include(failure.message, 'thread "thread"');
    assert.include(failure.message, "source user+assistant=2, migrated user+text=1");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("checks question identity even when the total open count is unchanged", () =>
  Effect.gen(function* () {
    yield* seedSource;
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE thread_items SET source_id = 'question:wrong' WHERE source_id = 'question:open'`;
    const failure = yield* Effect.flip(verifyCleanCoreBackfill);
    assert.include(failure.message, 'thread "thread", item "question:open"');
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back the first canonical insert and earlier tracker repair together", () =>
  Effect.gen(function* () {
    yield* seedSource;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE effect_sql_migrations SET name = 'ProjectPullRequestPins' WHERE migration_id = 54`;
    const readTracker = sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const readSchema = sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`;
    const trackerBefore = yield* readTracker;
    const schemaBefore = yield* readSchema;
    let inserted = false;
    // Rehearsal injection is confined to this test client, after the real INSERT.
    const injected = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const statement = Reflect.apply(target, thisArg, args);
        if (
          Array.isArray(args[0]) &&
          /INSERT OR IGNORE INTO threads\s*\(/.test(args[0].join("?"))
        ) {
          return statement.pipe(
            Effect.andThen(
              Effect.sync(() => {
                inserted = true;
              }),
            ),
            Effect.andThen(Effect.fail(new Error("injected after the first thread insert"))),
          );
        }
        return statement;
      },
    });
    const result = yield* Effect.exit(
      runMigrations().pipe(Effect.provideService(SqlClient.SqlClient, injected)),
    );
    assert.isTrue(inserted);
    if (!Exit.isFailure(result)) throw new Error("Expected the injected migration to fail");
    assert.include(Cause.pretty(result.cause), "injected after the first thread insert");
    assert.deepStrictEqual(yield* readTracker, trackerBefore);
    assert.deepStrictEqual(yield* readSchema, schemaBefore);
    assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS count FROM projection_thread_messages`, [
      { count: 2 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects a lost thread before reporting any item mismatch", () =>
  Effect.gen(function* () {
    yield* seedSource;
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM threads WHERE id = 'thread'`;
    const failure = yield* Effect.flip(verifyCleanCoreBackfill);
    assert.include(failure.message, "projection_threads=1, threads=0");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rejects an answered question incorrectly migrated as open", () =>
  Effect.gen(function* () {
    yield* seedSource;
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE thread_items SET status = 'open' WHERE source_id = 'question:answered'`;
    const failure = yield* Effect.flip(verifyCleanCoreBackfill);
    assert.include(
      failure.message,
      'Unexpected open question after backfill for thread "thread", item "question:answered"',
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

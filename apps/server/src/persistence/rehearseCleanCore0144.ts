import { readRehearsalSourceSnapshot } from "./Migrations/rehearsalSourceSnapshot.ts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

/**
 * Rehearsal harness for the clean-core backfill (step 4 / step 12).
 *
 * Prepare the copy with a consistent snapshot through a read-only,
 * NON-immutable connection — `immutable=1` ignores the live WAL and yields a
 * torn database. Under the lifecycle lock with Penkra quit (or on a copy):
 *   sqlite3 "file:<source>?mode=ro" "VACUUM INTO '<scratch>/state.sqlite';"
 * (or the SQLite backup API). Check free disk first (a copy is ~source size,
 * and VACUUM INTO needs room for both); delete old rehearsal copies afterwards.
 * Then run this harness against the copy.
 */
const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: bun rehearseCleanCore0144.ts <db-path>");

const count = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`,
    (rows) => rows[0]?.count ?? -1,
  );

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const source = yield* readRehearsalSourceSnapshot;
  const before = source.counts;

  const startedAt = Date.now();
  const executed = yield* runMigrations();
  const durationMs = Date.now() - startedAt;

  const after = {
    threads: yield* count(sql, "threads"),
    thread_items: yield* count(sql, "thread_items"),
    thread_items_user_or_text: (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_items WHERE kind IN ('user', 'text')
      `)[0]?.count,
    open_questions: (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM thread_items WHERE kind = 'question' AND status = 'open'
      `)[0]?.count,
  };

  const migratedCounts = yield* sql<{
    threadId: string;
    items: number;
  }>`SELECT thread_id AS "threadId",count(*) AS items FROM thread_items WHERE kind IN ('user','text') GROUP BY thread_id`;
  const expected = new Map(source.messages.map((row) => [row.threadId, row.source]));
  const actual = new Map(migratedCounts.map((row) => [row.threadId, row.items]));
  const mismatches = [...new Set([...expected.keys(), ...actual.keys()])].flatMap((threadId) => {
    const source = expected.get(threadId) ?? 0,
      items = actual.get(threadId) ?? 0;
    return source === items ? [] : [{ threadId, source, items }];
  });

  console.log(
    JSON.stringify(
      {
        database: dbPath,
        executed: executed.map(([id, name]) => `${id}_${name}`),
        durationMs,
        before,
        after,
        messageMismatchThreads: mismatches,
      },
      null,
      2,
    ),
  );
});

await Effect.runPromise(program.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))));

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: bun rehearseCleanCore0144.ts <db-path>");

const count = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`,
    (rows) => rows[0]?.count ?? -1,
  );

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const before = {
    projection_threads: yield* count(sql, "projection_threads"),
    projection_thread_messages: yield* count(sql, "projection_thread_messages"),
    projection_thread_activities: yield* count(sql, "projection_thread_activities"),
    operations: yield* count(sql, "operations"),
    notices: yield* count(sql, "notices"),
    pending_user_input: (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pending_interactions
        WHERE interaction_kind = 'userInput'
      `)[0]?.count,
  };

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

  // Per-thread message preservation: user+assistant source rows equal user/text items.
  const mismatches = yield* sql<{
    readonly threadId: string;
    readonly source: number;
    readonly items: number;
  }>`
    SELECT s.thread_id AS "threadId", s.source AS source, COALESCE(i.items, 0) AS items
    FROM (
      SELECT thread_id, COUNT(*) AS source FROM projection_thread_messages
      WHERE role IN ('user', 'assistant') GROUP BY thread_id
    ) s
    LEFT JOIN (
      SELECT thread_id, COUNT(*) AS items FROM thread_items
      WHERE kind IN ('user', 'text') GROUP BY thread_id
    ) i ON i.thread_id = s.thread_id
    WHERE s.source <> COALESCE(i.items, 0)
    LIMIT 20
  `;

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

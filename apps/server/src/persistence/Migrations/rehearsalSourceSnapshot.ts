// Purpose: Capture historical migration inputs before the clean-core drop.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export const readRehearsalSourceSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Rehearsal inputs can be pre-cutover or already on clean core. This is
  // historical verification tooling, never a runtime reader or compatibility path.
  const canonical =
    (yield* sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'`).length > 0;
  const count = (table: string) =>
    sql<{ count: number }>`SELECT count(*) AS count FROM ${sql(table)}`.pipe(
      Effect.map((rows) => rows[0]!.count),
    );
  const counts = canonical
    ? {
        threads: yield* count("threads"),
        userAndText: (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM thread_items WHERE kind IN ('user','text')`)[0]!.count,
        openQuestions: (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM thread_items WHERE kind='question' AND status='open'`)[0]!
          .count,
      }
    : {
        threads: yield* count("projection_threads"),
        userAndText: (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM projection_thread_messages WHERE role IN ('user','assistant')`)[0]!
          .count,
        openQuestions: (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM projection_pending_interactions WHERE interaction_kind='userInput' AND status<>'confirmed'`)[0]!
          .count,
      };
  const messages = canonical
    ? yield* sql<{
        threadId: string;
        source: number;
      }>`SELECT thread_id AS "threadId",count(*) AS source FROM thread_items WHERE kind IN ('user','text') GROUP BY thread_id`
    : yield* sql<{
        threadId: string;
        source: number;
      }>`SELECT thread_id AS "threadId",count(*) AS source FROM projection_thread_messages WHERE role IN ('user','assistant') GROUP BY thread_id`;
  return {
    counts,
    messages,
    source: canonical ? ("clean-core" as const) : ("projections" as const),
  };
});

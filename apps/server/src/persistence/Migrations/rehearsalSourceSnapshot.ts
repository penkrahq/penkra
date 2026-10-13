// Purpose: Capture historical migration inputs before the clean-core drop.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export const readRehearsalSourceSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const count = (table: string) =>
    sql<{ count: number }>`SELECT count(*) AS count FROM ${sql(table)}`.pipe(
      Effect.map((rows) => rows[0]!.count),
    );
  const counts = {
    projection_threads: yield* count("projection_threads"),
    projection_thread_messages: yield* count("projection_thread_messages"),
    projection_thread_activities: yield* count("projection_thread_activities"),
    operations: yield* count("operations"),
    notices: yield* count("notices"),
    pending_user_input: (yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM projection_pending_interactions WHERE interaction_kind='userInput'`)[0]!
      .count,
  };
  const messages = yield* sql<{
    threadId: string;
    source: number;
  }>`SELECT thread_id AS "threadId",count(*) AS source FROM projection_thread_messages WHERE role IN ('user','assistant') GROUP BY thread_id`;
  return { counts, messages };
});

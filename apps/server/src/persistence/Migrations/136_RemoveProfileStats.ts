import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS profile_stats_deleted_tokens`;
  yield* sql`DROP TABLE IF EXISTS profile_stats_deleted_skills`;
  yield* sql`DROP TABLE IF EXISTS profile_stats_deleted_turns`;
  yield* sql`DROP TABLE IF EXISTS profile_stats_deleted_prompts`;
  yield* sql`DROP TABLE IF EXISTS profile_stats_deleted_threads`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_profile_prompt_activity`;
  yield* sql`DROP INDEX IF EXISTS idx_orchestration_events_profile_turn_events`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_profile_token_activity`;
});

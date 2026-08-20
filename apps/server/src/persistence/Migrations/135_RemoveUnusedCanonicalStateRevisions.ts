// Purpose: Remove row-delta revision schema superseded by snapshot-plus-event synchronization.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const projectionTables = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_turns",
  "projection_thread_sessions",
  "projection_projects",
  "projection_spaces",
  "projection_pending_interactions",
] as const;

const revisionTables = [
  ...projectionTables,
  "operations",
  "notices",
  "connection_rate_limits",
  "connection_usage_daily",
] as const;

const revisionIndexes = [
  "idx_projection_thread_messages_thread_updated_seq",
  "idx_projection_thread_activities_thread_updated_seq",
  "idx_projection_threads_updated_seq",
  "idx_operations_thread_updated",
  "idx_notices_thread_updated",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const table of projectionTables) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${table}_canonical_revision_insert`);
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${table}_canonical_revision_update`);
  }

  for (const index of revisionIndexes) {
    yield* sql.unsafe(`DROP INDEX IF EXISTS ${index}`);
  }

  for (const table of revisionTables) {
    const columns = yield* sql.unsafe<{ readonly name: string }>(
      `SELECT name FROM pragma_table_info('${table}')`,
    );
    if (columns.some(({ name }) => name === "updated_seq")) {
      yield* sql.unsafe(`ALTER TABLE ${table} DROP COLUMN updated_seq`);
    }
  }

  yield* sql`DROP TABLE IF EXISTS canonical_state_sequence`;
});

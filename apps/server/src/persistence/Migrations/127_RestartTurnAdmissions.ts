import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A start is recoverable when admitted, before a provider turn id exists. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string; readonly notNull: number }>`
    SELECT name, "notnull" AS "notNull"
    FROM pragma_table_info('restart_turn_recoveries')
  `;
  const turnId = columns.find(({ name }) => name === "turn_id");
  const messageId = columns.find(({ name }) => name === "message_id");
  if (turnId?.notNull === 0 && messageId?.notNull === 0) return;

  yield* sql`ALTER TABLE restart_turn_recoveries RENAME TO restart_turn_recoveries_v126`;
  yield* sql`
    CREATE TABLE restart_turn_recoveries (
      thread_id TEXT PRIMARY KEY,
      turn_id TEXT,
      message_id TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO restart_turn_recoveries (
      thread_id, turn_id, message_id, requested_at, updated_at
    )
    SELECT old.thread_id, old.turn_id, turns.pending_message_id,
           old.requested_at, old.updated_at
    FROM restart_turn_recoveries_v126 AS old
    LEFT JOIN projection_turns AS turns
      ON turns.thread_id = old.thread_id AND turns.turn_id = old.turn_id
  `;
  yield* sql`DROP TABLE restart_turn_recoveries_v126`;
});

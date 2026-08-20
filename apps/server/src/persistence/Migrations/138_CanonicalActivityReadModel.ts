import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Cut Thread activity reads over to canonical operations/notices while retaining
 * the existing projection table as immutable legacy history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [operationRows, noticeRows] = yield* Effect.all([
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM operations`,
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM notices`,
  ]);
  yield* Effect.log("Rebuilding pre-cutover canonical activity scaffolding").pipe(
    Effect.annotateLogs({
      clearedOperationCount: Number(operationRows[0]?.count ?? 0),
      clearedNoticeCount: Number(noticeRows[0]?.count ?? 0),
    }),
  );

  // Every pre-cutover row is already represented in projection_thread_activities.
  // Rebuild instead of guessing whether its provider envelope is normalized.
  yield* sql`DROP TABLE operations`;
  yield* sql`
    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY,
      provider_operation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      provider TEXT NOT NULL,
      item_type TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('started', 'running', 'completed', 'failed', 'cancelled', 'aborted', 'interrupted')
      ),
      input_json TEXT,
      detail_json TEXT NOT NULL,
      activity_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_source_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_operations_provider_identity
    ON operations(provider, thread_id, COALESCE(turn_id, ''), provider_operation_id)
  `;
  yield* sql`
    CREATE INDEX idx_operations_thread_updated
    ON operations(thread_id, updated_at, operation_id)
  `;

  yield* sql`DELETE FROM notices`;
  yield* sql`DROP VIEW IF EXISTS thread_activities_read`;
  yield* sql`
    CREATE VIEW thread_activities_read AS
    SELECT
      legacy.activity_id,
      legacy.thread_id,
      legacy.turn_id,
      legacy.tone,
      legacy.kind,
      legacy.summary,
      legacy.payload_json,
      legacy.sequence,
      legacy.created_at
    FROM projection_thread_activities AS legacy
    WHERE NOT EXISTS (
      SELECT 1
      FROM notices
      WHERE notices.notice_id = legacy.activity_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM operations
        WHERE operations.thread_id = legacy.thread_id
          AND COALESCE(operations.turn_id, '') = COALESCE(legacy.turn_id, '')
          AND operations.provider_operation_id =
            json_extract(legacy.payload_json, '$.operationId')
      )
    UNION ALL
    SELECT
      operation_id AS activity_id,
      thread_id,
      turn_id,
      json_extract(activity_json, '$.tone') AS tone,
      json_extract(activity_json, '$.kind') AS kind,
      json_extract(activity_json, '$.summary') AS summary,
      json_extract(activity_json, '$.payload') AS payload_json,
      NULL AS sequence,
      updated_at AS created_at
    FROM operations
    UNION ALL
    SELECT
      notice_id AS activity_id,
      thread_id,
      turn_id,
      tone,
      kind,
      summary,
      detail_json AS payload_json,
      NULL AS sequence,
      created_at
    FROM notices
  `;
});

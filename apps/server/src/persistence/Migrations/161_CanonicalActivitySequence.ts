import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Reuse the accepted touch-command sequence shared by live delivery. Historical
// rows without an exact accepted receipt retain unknown order; never invent one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [operationColumns, noticeColumns] = yield* Effect.all([
    sql<{ readonly name: string }>`PRAGMA table_info(operations)`,
    sql<{ readonly name: string }>`PRAGMA table_info(notices)`,
  ]);
  // Lineage reconciliation may replay migrations against already-upgraded tables.
  if (!operationColumns.some((column) => column.name === "presentation_sequence")) {
    yield* sql`ALTER TABLE operations ADD COLUMN presentation_sequence INTEGER CHECK (presentation_sequence >= 0)`;
  }
  if (!noticeColumns.some((column) => column.name === "presentation_sequence")) {
    yield* sql`ALTER TABLE notices ADD COLUMN presentation_sequence INTEGER CHECK (presentation_sequence >= 0)`;
  }
  yield* sql`
    UPDATE operations SET presentation_sequence = (
      SELECT result_sequence FROM orchestration_command_receipts
      WHERE command_id = 'provider:' || operations.last_source_event_id ||
        ':activity-read-model-touch:' || operations.thread_id
        AND aggregate_id = operations.thread_id AND status = 'accepted'
    ) WHERE presentation_sequence IS NULL
  `;
  yield* sql`
    UPDATE notices SET presentation_sequence = (
      SELECT result_sequence FROM orchestration_command_receipts
      WHERE command_id = 'provider:' || notices.notice_id ||
        ':activity-read-model-touch:' || notices.thread_id
        AND aggregate_id = notices.thread_id AND status = 'accepted'
    ) WHERE presentation_sequence IS NULL
  `;
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
      presentation_sequence AS sequence,
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
      presentation_sequence AS sequence,
      created_at
    FROM notices
  `;
});

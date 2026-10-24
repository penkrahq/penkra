// Purpose: Verify the 0.14.4 backfill before its migration transaction can commit.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export const verifyCleanCoreBackfill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{ source: number; migrated: number }>`
    SELECT (SELECT COUNT(*) FROM projection_threads) AS source,
           (SELECT COUNT(*) FROM threads) AS migrated
  `;
  if (counts === undefined || counts.source !== counts.migrated) {
    return yield* Effect.fail(
      new Error(
        `Thread backfill count mismatch: projection_threads=${counts?.source}, threads=${counts?.migrated}`,
      ),
    );
  }
  const [messageMismatch] = yield* sql<{ threadId: string; source: number; migrated: number }>`
    WITH source_counts AS (
      SELECT thread_id, COUNT(*) AS count FROM projection_thread_messages
      WHERE role IN ('user', 'assistant') GROUP BY thread_id
    ), migrated_counts AS (
      SELECT thread_id, COUNT(*) AS count FROM thread_items
      WHERE kind IN ('user', 'text') GROUP BY thread_id
    )
    SELECT COALESCE(s.thread_id, m.thread_id) AS "threadId", COALESCE(s.count, 0) AS source,
           COALESCE(m.count, 0) AS migrated
    FROM source_counts s FULL OUTER JOIN migrated_counts m ON m.thread_id = s.thread_id
    WHERE COALESCE(s.count, 0) <> COALESCE(m.count, 0)
    ORDER BY "threadId" LIMIT 1
  `;
  if (messageMismatch !== undefined) {
    return yield* Effect.fail(
      new Error(
        `Message backfill count mismatch for thread "${messageMismatch.threadId}": source user+assistant=${messageMismatch.source}, migrated user+text=${messageMismatch.migrated}`,
      ),
    );
  }
  const [questionMismatch] = yield* sql<{ threadId: string; sourceId: string }>`
    SELECT p.thread_id AS "threadId", 'question:' || p.request_id AS "sourceId"
    FROM projection_pending_interactions p
    WHERE p.interaction_kind = 'userInput' AND p.status <> 'confirmed'
      AND NOT EXISTS (
        SELECT 1 FROM thread_items i WHERE i.thread_id = p.thread_id
          AND i.source_id = 'question:' || p.request_id
          AND i.kind = 'question' AND i.status = 'open'
      )
    ORDER BY p.thread_id, p.request_id LIMIT 1
  `;
  if (questionMismatch !== undefined) {
    return yield* Effect.fail(
      new Error(
        `Open question backfill mismatch for thread "${questionMismatch.threadId}", item "${questionMismatch.sourceId}"`,
      ),
    );
  }
  const [unexpectedQuestion] = yield* sql<{ threadId: string; sourceId: string }>`
    SELECT i.thread_id AS "threadId", i.source_id AS "sourceId" FROM thread_items i
    WHERE i.kind = 'question' AND i.status = 'open' AND NOT EXISTS (
      SELECT 1 FROM projection_pending_interactions p WHERE p.thread_id = i.thread_id
        AND 'question:' || p.request_id = i.source_id
        AND p.interaction_kind = 'userInput' AND p.status <> 'confirmed'
    ) ORDER BY i.thread_id, i.source_id LIMIT 1
  `;
  if (unexpectedQuestion !== undefined) {
    return yield* Effect.fail(
      new Error(
        `Unexpected open question after backfill for thread "${unexpectedQuestion.threadId}", item "${unexpectedQuestion.sourceId}"`,
      ),
    );
  }
});

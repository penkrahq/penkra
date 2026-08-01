import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "../Services/ProviderRuntimeEvents.ts";

/**
 * Splits provider-runtime projection progress by thread.
 *
 * The raw journal remains global and immutable, but a projection failure may
 * now pause only its owning thread. The failure ledger preserves enough
 * evidence to diagnose and replay a quarantined row without silently skipping
 * it or freezing unrelated conversations.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const migratedAt = new Date().toISOString();

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_runtime_thread_cursors (
      thread_id TEXT PRIMARY KEY,
      last_acked_sequence INTEGER NOT NULL DEFAULT 0
        CHECK (last_acked_sequence >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_runtime_thread_cursors_sequence
    ON provider_runtime_thread_cursors(last_acked_sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_runtime_projection_failures (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      event_type TEXT NOT NULL,
      error_fingerprint TEXT NOT NULL,
      error_detail TEXT NOT NULL,
      attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
      first_failed_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL,
      next_retry_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'quarantined', 'resolved')),
      quarantined_at TEXT,
      resolved_at TEXT,
      FOREIGN KEY (sequence) REFERENCES provider_runtime_events(sequence) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_runtime_projection_failures_blocked_thread
    ON provider_runtime_projection_failures(thread_id)
    WHERE status IN ('active', 'quarantined')
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_runtime_projection_failures_status_time
    ON provider_runtime_projection_failures(status, last_failed_at)
  `;

  // Every row at or below the legacy global cursor has already been accepted.
  // Seed only from retained journal rows; pruned rows need no cursor because a
  // future thread head is defined as the next existing row, not sequence + 1.
  yield* sql`
    INSERT INTO provider_runtime_thread_cursors (
      thread_id, last_acked_sequence, created_at, updated_at
    )
    SELECT
      event.thread_id,
      MAX(event.sequence),
      ${migratedAt},
      ${migratedAt}
    FROM provider_runtime_events AS event
    INNER JOIN provider_runtime_event_consumers AS consumer
      ON consumer.consumer_name = ${PROVIDER_RUNTIME_INGESTION_CONSUMER}
     AND event.sequence <= consumer.last_acked_sequence
    GROUP BY event.thread_id
    ON CONFLICT (thread_id) DO UPDATE SET
      last_acked_sequence = MAX(
        provider_runtime_thread_cursors.last_acked_sequence,
        excluded.last_acked_sequence
      ),
      updated_at = excluded.updated_at
  `;
});

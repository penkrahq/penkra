// Purpose: Retire the replaced command, event, delivery and read-model pipeline.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Repair the 176 omission before removing its source. Already-dropped sources
  // are handled honestly as unknown historical senders by migration 203.
  const legacyMessages =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_thread_messages'`;
  if (legacyMessages.length) {
    const [before] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM thread_items i
      JOIN projection_thread_messages m ON m.thread_id=i.thread_id AND m.message_id=i.source_id
      WHERE i.kind='user' AND m.dispatch_origin='agent' AND m.sender_thread_id IS NOT NULL
        AND json_extract(i.data,'$.senderThreadId') IS NULL`;
    yield* sql`UPDATE thread_items AS i SET data=json_set(COALESCE(data,'{}'),'$.senderThreadId',
      (SELECT m.sender_thread_id FROM projection_thread_messages m WHERE m.thread_id=i.thread_id AND m.message_id=i.source_id))
      WHERE i.kind='user' AND json_extract(i.data,'$.senderThreadId') IS NULL AND EXISTS
        (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id=i.thread_id AND m.message_id=i.source_id
          AND m.dispatch_origin='agent' AND m.sender_thread_id IS NOT NULL)`;
    yield* Effect.logInfo("Preserved agent senders before legacy table removal", {
      restored: before!.count,
    });
  }
  yield* sql`DROP VIEW IF EXISTS thread_activities_read`;
  const tables = [
    "provider_intent_outbox_reconciliations",
    "provider_delivery_reconciliations",
    "provider_intent_outbox_cutover",
    "provider_intent_outbox",
    "orchestration_event_deliveries",
    "orchestration_consumer_state",
    "orchestration_command_receipts",
    "queued_turn_promotions",
    "restart_turn_recoveries",
    "provider_runtime_projection_failures",
    "provider_runtime_retention_event_work",
    "provider_runtime_retention_turn_work",
    "provider_runtime_retention_state",
    "provider_runtime_thread_cursors",
    "provider_runtime_diagnostic_episodes",
    "provider_runtime_open_turns",
    "provider_runtime_event_consumers",
    "provider_runtime_events",
    "projection_turn_provider_bindings",
    "projection_pending_interactions",
    "operations",
    "notices",
    "projection_thread_messages_search",
    "projection_thread_message_search",
    "projection_thread_messages_fts",
    "projection_thread_messages",
    "projection_thread_activities",
    "projection_thread_sessions",
    "projection_turns",
    "projection_state",
    "projection_threads",
    "lost_and_found",
    "operational_diagnostics",
    "orchestration_events",
  ];
  for (const table of tables) yield* sql`DROP TABLE IF EXISTS ${sql.literal('"' + table + '"')}`;
  yield* sql`PRAGMA foreign_key_check`.pipe(
    Effect.flatMap((rows) =>
      rows.length === 0
        ? Effect.void
        : Effect.fail(new Error("Dropping the legacy pipeline left a foreign-key violation.")),
    ),
  );
});

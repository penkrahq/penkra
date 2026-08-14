import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("BackfillRestartTurnRecoveries migration", (it) => {
  it.effect("recovers upgrade-boundary shutdowns but excludes explicit Stop", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 116 });
      const requestedAt = "2026-08-13T23:39:17.778Z";
      const stoppedAt = "2026-08-14T00:00:12.072Z";

      for (const suffix of ["shutdown", "explicit-stop"] as const) {
        const threadId = `thread-${suffix}`;
        const turnId = `turn-${suffix}`;
        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, runtime_mode,
            active_turn_id, last_error, updated_at
          ) VALUES (
            ${threadId}, 'stopped', 'codex', 'full-access',
            NULL, NULL, ${stoppedAt}
          )
        `;
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, assistant_message_id,
            state, requested_at, started_at, completed_at,
            checkpoint_turn_count, checkpoint_ref, checkpoint_status,
            checkpoint_files_json
          ) VALUES (
            ${threadId}, ${turnId}, NULL, NULL,
            'interrupted', ${requestedAt}, ${requestedAt}, ${stoppedAt},
            NULL, NULL, NULL, '[]'
          )
        `;
      }

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-explicit-stop', 'thread', 'thread-explicit-stop', 0,
          'thread.turn-interrupt-requested', ${stoppedAt}, 'cmd-explicit-stop',
          NULL, 'cmd-explicit-stop', 'user', '{}', '{}'
        )
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 117 }), [
        [117, "BackfillRestartTurnRecoveries"],
      ]);
      const rows = yield* sql<{ readonly threadId: string; readonly turnId: string }>`
        SELECT thread_id AS "threadId", turn_id AS "turnId"
        FROM restart_turn_recoveries
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [{ threadId: "thread-shutdown", turnId: "turn-shutdown" }]);
    }),
  );
});

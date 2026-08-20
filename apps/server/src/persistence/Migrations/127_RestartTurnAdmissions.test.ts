import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("127_RestartTurnAdmissions", (it) => {
  it.effect("preserves existing turn markers and their admitted message identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 126 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          'thread-1', 'turn-1', 'message-1', NULL, 'running',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z', NULL,
          NULL, NULL, NULL, '[]'
        )
      `;
      yield* sql`
        INSERT INTO restart_turn_recoveries (thread_id, turn_id, requested_at, updated_at)
        VALUES ('thread-1', 'turn-1', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 127 });
      const rows = yield* sql<{
        readonly turnId: string | null;
        readonly messageId: string | null;
      }>`
        SELECT turn_id AS "turnId", message_id AS "messageId"
        FROM restart_turn_recoveries
      `;
      assert.deepStrictEqual(rows, [{ turnId: "turn-1", messageId: "message-1" }]);

      yield* sql`
        INSERT INTO restart_turn_recoveries (
          thread_id, turn_id, message_id, requested_at, updated_at
        ) VALUES (
          'thread-admitted', NULL, 'message-admitted',
          '2026-08-19T00:01:00.000Z', '2026-08-19T00:01:00.000Z'
        )
      `;
    }),
  );
});

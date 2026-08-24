import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("150_ResetConnectionUsageAccounting", (it) => {
  it.effect("discards inflated aggregates while preserving reported rate limits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const timestamp = "2026-08-23T12:00:00.000Z";
      yield* runMigrations({ toMigrationInclusive: 149 });

      yield* sql`
        INSERT INTO connection_rate_limits (
          connection_id, provider, limits_json, status, last_source_event_id, updated_at
        ) VALUES (
          'claude-account', 'claudeAgent', '[{"window":"five-hour","resetsAt":"2026-08-23T18:40:00.000Z"}]',
          'allowed', 'rate-limit-event', ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO connection_usage_daily (
          utc_day, connection_id, provider, input_tokens, output_tokens,
          reasoning_output_tokens, turns, updated_at
        ) VALUES (
          '2026-08-23', 'claude-account', 'claudeAgent', 90000, 2000, 0, 3, ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO connection_usage_cursors (
          thread_id, connection_id, input_tokens, output_tokens,
          reasoning_output_tokens, last_source_event_id, updated_at
        ) VALUES ('thread-1', 'claude-account', 90000, 2000, 0, 'gauge-event', ${timestamp})
      `;
      yield* sql`
        INSERT INTO connection_usage_turn_events (source_event_id, connection_id, utc_day)
        VALUES ('gauge-event', 'claude-account', '2026-08-23')
      `;

      yield* runMigrations({ toMigrationInclusive: 150 });

      const dailyRows = yield* sql`SELECT * FROM connection_usage_daily`;
      const turnRows = yield* sql`SELECT * FROM connection_usage_turn_events`;
      const rateLimitRows = yield* sql<{ readonly sourceEventId: string }>`
        SELECT last_source_event_id AS "sourceEventId" FROM connection_rate_limits
      `;
      const cursorTables = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'connection_usage_cursors'
      `;

      assert.deepStrictEqual(dailyRows, []);
      assert.deepStrictEqual(turnRows, []);
      assert.deepStrictEqual(rateLimitRows, [{ sourceEventId: "rate-limit-event" }]);
      assert.deepStrictEqual(cursorTables, [{ count: 0 }]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import dropUnusedStorage from "./189_DropUnusedDiagnosticsAndRateLimits.ts";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 188 });
  const at = "2026-10-11T00:00:00.000Z";
  yield* sql`INSERT INTO connection_rate_limits (
    connection_id, provider, limits_json, status, last_source_event_id, updated_at
  ) VALUES ('usage-account', 'codex', '[{"remaining":42}]', 'allowed', 'limit-event', ${at})`;
  yield* sql`INSERT INTO operational_diagnostics (
    thread_id, source, diagnostic_kind, severity, code, detail_json, occurred_at
  ) VALUES ('old-thread', 'server', 'old-diagnostic', 'warning', 'old-code', '{}', ${at})`;
  yield* sql`INSERT INTO connection_usage_daily (
    utc_day, connection_id, provider, input_tokens, output_tokens,
    reasoning_output_tokens, turns, updated_at
  ) VALUES ('2026-10-11', 'usage-account', 'codex', 123, 456, 7, 2, ${at})`;
  yield* sql`INSERT INTO connection_usage_turn_events (source_event_id, connection_id, utc_day)
    VALUES ('usage-event', 'usage-account', '2026-10-11')`;
});

it.effect(
  "drops retired storage and preserves usage accounting and its deduplication records",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const usage =
        yield* sql`SELECT * FROM connection_usage_daily ORDER BY utc_day, connection_id`;
      const events =
        yield* sql`SELECT * FROM connection_usage_turn_events ORDER BY source_event_id`;
      const spaces = yield* sql`SELECT * FROM projection_spaces ORDER BY space_id`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 189 }), [
        [189, "DropUnusedDiagnosticsAndRateLimits"],
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM connection_usage_daily ORDER BY utc_day, connection_id`,
        usage,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM connection_usage_turn_events ORDER BY source_event_id`,
        events,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_spaces ORDER BY space_id`, spaces);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE
        sql LIKE '%operational_diagnostics%' OR sql LIKE '%connection_rate_limits%'`,
        [],
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps both retired tables intact when the drop transaction rolls back", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`;
    const limits = yield* sql`SELECT * FROM connection_rate_limits ORDER BY connection_id`;
    const diagnostics = yield* sql`SELECT * FROM operational_diagnostics ORDER BY sequence`;
    const error = yield* Effect.flip(
      sql.withTransaction(
        dropUnusedStorage.pipe(Effect.andThen(Effect.fail(new Error("injected failure")))),
      ),
    );
    assert.equal(error.message, "injected failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY type, name`, schema);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM connection_rate_limits ORDER BY connection_id`,
      limits,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM operational_diagnostics ORDER BY sequence`,
      diagnostics,
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

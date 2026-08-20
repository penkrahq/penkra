import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS connection_rate_limits (
      connection_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      status TEXT,
      last_source_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS connection_usage_daily (
      utc_day TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_output_tokens >= 0),
      turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (utc_day, connection_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS connection_usage_cursors (
      thread_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      last_source_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, connection_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS connection_usage_turn_events (
      source_event_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      utc_day TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_connection_usage_daily_provider_day
    ON connection_usage_daily(provider, utc_day)
  `;
});

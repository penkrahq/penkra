import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Migration 126 initially derived account totals from context-window gauge events.
// Those gauges are not monotonic billing counters, so the resulting aggregates
// can double-count across turns. Discard only that derived data; future terminal
// turn events rebuild trustworthy totals under the corrected accounting path.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM connection_usage_daily`;
  yield* sql`DELETE FROM connection_usage_turn_events`;
  yield* sql`DROP TABLE IF EXISTS connection_usage_cursors`;
});

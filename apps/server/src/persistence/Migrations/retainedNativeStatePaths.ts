// Historical input captured before the provider-state tables are dropped.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export const readRetainedNativeStateIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='provider_native_state_generations'`;
  if (table.length === 0) return [] as ReadonlyArray<string>;
  const rows = yield* sql<{
    id: string;
  }>`SELECT native_state_generation_id AS id FROM provider_native_state_generations WHERE lifecycle='retained' ORDER BY native_state_generation_id`;
  return rows.map((row) => row.id);
});

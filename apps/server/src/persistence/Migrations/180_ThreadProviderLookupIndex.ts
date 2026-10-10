// FILE: 180_ThreadProviderLookupIndex.ts
// Purpose: Index provider admission lookups without hydrating thread snapshots.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_threads_provider_live ON threads(provider, id) WHERE deleted_at IS NULL`;
});

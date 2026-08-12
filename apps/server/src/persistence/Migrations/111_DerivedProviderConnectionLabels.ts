// FILE: 111_DerivedProviderConnectionLabels.ts
// Purpose: Allows independently authenticated Connections to share the same derived display label.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS provider_connections_active_label`;
});

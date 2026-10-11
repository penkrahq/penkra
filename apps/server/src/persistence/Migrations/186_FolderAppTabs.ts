// Purpose: Store the shared App panel on its folder; runtime metadata stays in each window.
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_folders ADD COLUMN app_tabs TEXT NOT NULL DEFAULT '{"open":false,"panes":[],"activePaneId":null}'`;
});

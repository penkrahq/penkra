// Purpose: Store the shared App-tab list on its folder; navigation stays in each window.
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_folders ADD COLUMN app_tabs TEXT NOT NULL DEFAULT '{"panes":[]}'`;
});

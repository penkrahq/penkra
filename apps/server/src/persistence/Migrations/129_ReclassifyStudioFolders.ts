import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Studio is no longer a container kind; preserve every row as an ordinary folder. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE projection_projects
    SET kind = 'project'
    WHERE kind = 'studio'
  `;
  yield* sql`
    UPDATE projection_thread_activities
    SET kind = 'legacy.outputs.captured'
    WHERE kind = 'studio.outputs.captured'
  `;
});

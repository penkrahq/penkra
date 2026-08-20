// Purpose: Restore the required Space assignment for folders reclassified after migration 94.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PERSONAL_SPACE_ID = "penkra-personal";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 94 assigned the Personal Space only to rows that were already ordinary projects.
  // Migration 129 subsequently preserved legacy Studio containers by reclassifying them as
  // projects, so already-upgraded databases can contain an ordinary folder with a null Space.
  yield* sql`
    UPDATE projection_projects
    SET space_id = ${PERSONAL_SPACE_ID}
    WHERE kind = 'project' AND space_id IS NULL
  `;

  // Keep replayable project events aligned with the repaired canonical projection.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.spaceId', ${PERSONAL_SPACE_ID})
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND stream_id IN (
        SELECT project_id FROM projection_projects WHERE kind = 'project'
      )
      AND COALESCE(json_type(payload_json, '$.spaceId'), 'null') = 'null'
  `;
});

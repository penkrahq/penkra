// Purpose: Clean-cut migration from nullable Space assignments to persisted Spaces only.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PERSONAL_SPACE_ID = "penkra-personal";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Ordinary folders inherit no global fallback: migrate their one-time historical null
  // assignments to the seeded Personal Space, then require every future command to name one.
  yield* sql`
    UPDATE projection_projects
    SET space_id = ${PERSONAL_SPACE_ID}
    WHERE kind = 'project' AND space_id IS NULL
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.spaceId', ${PERSONAL_SPACE_ID})
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND stream_id IN (
        SELECT project_id FROM projection_projects WHERE kind = 'project'
      )
      AND COALESCE(json_type(payload_json, '$.spaceId'), 'null') = 'null'
  `;

  // A chat-container thread is directly Space-scoped. Folder threads continue to inherit
  // their parent folder's Space and therefore intentionally keep a null thread-level value.
  yield* sql`
    UPDATE projection_threads
    SET space_id = ${PERSONAL_SPACE_ID}
    WHERE space_id IS NULL
      AND project_id IN (
        SELECT project_id FROM projection_projects WHERE kind = 'chat'
      )
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.spaceId', ${PERSONAL_SPACE_ID})
    WHERE event_type IN ('thread.created', 'thread.meta-updated')
      AND json_extract(payload_json, '$.threadId') IN (
        SELECT thread_id
        FROM projection_threads
        WHERE project_id IN (
          SELECT project_id FROM projection_projects WHERE kind = 'chat'
        )
      )
      AND COALESCE(json_type(payload_json, '$.spaceId'), 'null') = 'null'
  `;

  yield* sql`
    INSERT INTO space_navigation_state (
      singleton_id,
      active_space_id,
      last_thread_id_by_space_json,
      last_project_id_by_space_json,
      updated_at
    ) VALUES (1, ${PERSONAL_SPACE_ID}, '{}', '{}', datetime('now'))
    ON CONFLICT(singleton_id) DO UPDATE SET
      active_space_id = COALESCE(space_navigation_state.active_space_id, ${PERSONAL_SPACE_ID}),
      last_thread_id_by_space_json = json_remove(
        space_navigation_state.last_thread_id_by_space_json,
        '$.void'
      ),
      last_project_id_by_space_json = json_remove(
        space_navigation_state.last_project_id_by_space_json,
        '$.void'
      )
  `;
});

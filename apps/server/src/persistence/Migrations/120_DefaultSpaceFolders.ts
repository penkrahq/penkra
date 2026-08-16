// FILE: 120_DefaultSpaceFolders.ts
// Purpose: Creates Untitled folders where needed and files legacy loose threads into them.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DEFAULT_FOLDER_PREFIX = "penkra-default-folder:";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    INSERT OR IGNORE INTO orchestration_events (
      event_id,
      aggregate_kind,
      stream_id,
      stream_version,
      event_type,
      occurred_at,
      command_id,
      causation_event_id,
      correlation_id,
      actor_kind,
      payload_json,
      metadata_json
    )
    SELECT
      'migration-120:default-folder:' || space.space_id,
      'project',
      '${DEFAULT_FOLDER_PREFIX}' || space.space_id,
      1,
      'project.created',
      space.created_at,
      NULL,
      NULL,
      NULL,
      'system',
      json_object(
        'projectId', '${DEFAULT_FOLDER_PREFIX}' || space.space_id,
        'kind', 'project',
        'title', 'Untitled',
        'workspaceRoot', json('null'),
        'defaultModelSelection', json('null'),
        'scripts', json('[]'),
        'isPinned', json('false'),
        'spaceId', space.space_id,
        'sidebarSortOrder', 0,
        'createdAt', space.created_at,
        'updatedAt', space.created_at
      ),
      '{}'
    FROM projection_spaces AS space
    WHERE EXISTS (
      SELECT 1
      FROM projection_threads AS thread
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE project.kind = 'chat' AND thread.space_id = space.space_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM orchestration_events AS existing
      WHERE existing.aggregate_kind = 'project'
        AND existing.stream_id = '${DEFAULT_FOLDER_PREFIX}' || space.space_id
    )
  `);

  // Append an authoritative move for each legacy loose thread. One thread per event keeps
  // every payload below the sidebar command size limit even for very large histories.
  yield* sql.unsafe(`
    WITH loose_threads AS (
      SELECT
        thread.thread_id,
        thread.space_id,
        ROW_NUMBER() OVER (
          PARTITION BY thread.space_id
          ORDER BY thread.created_at, thread.thread_id
        ) AS move_index,
        COALESCE((
          SELECT MAX(event.stream_version)
          FROM orchestration_events AS event
          WHERE event.aggregate_kind = 'space'
            AND event.stream_id = thread.space_id
        ), 0) AS previous_stream_version
      FROM projection_threads AS thread
      JOIN projection_projects AS project
        ON project.project_id = thread.project_id
       AND project.kind = 'chat'
      WHERE thread.space_id IS NOT NULL
    )
    INSERT INTO orchestration_events (
      event_id,
      aggregate_kind,
      stream_id,
      stream_version,
      event_type,
      occurred_at,
      command_id,
      causation_event_id,
      correlation_id,
      actor_kind,
      payload_json,
      metadata_json
    )
    SELECT
      'migration-120:file-thread:' || loose.thread_id,
      'space',
      loose.space_id,
      loose.previous_stream_version + loose.move_index,
      'sidebar.layout-updated',
      datetime('now'),
      NULL,
      NULL,
      NULL,
      'system',
      json_object(
        'projectUpdates', json('[]'),
        'threadUpdates', json_array(json_object(
          'threadId', loose.thread_id,
          'projectId', '${DEFAULT_FOLDER_PREFIX}' || loose.space_id,
          'spaceId', json('null')
        )),
        'updatedAt', datetime('now')
      ),
      '{}'
    FROM loose_threads AS loose
  `);
});

// FILE: 149_FolderOnlyHierarchy.ts
// Purpose: Hard-cut persisted orchestration state to Spaces -> folders -> threads.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PERSONAL_SPACE_ID = "penkra-personal";
const CHATS_FOLDER_PREFIX = "penkra-chats-folder:";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TEMP TABLE legacy_chat_containers (
      folder_id TEXT PRIMARY KEY
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO legacy_chat_containers (folder_id)
    SELECT project_id
    FROM projection_projects
    WHERE kind = 'chat'
       OR (title = 'Home' AND workspace_root IS NOT NULL)
  `);

  yield* sql.unsafe(`
    CREATE TEMP TABLE legacy_chat_threads (
      thread_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      folder_id TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    INSERT INTO legacy_chat_threads (thread_id, space_id, folder_id)
    SELECT
      thread.thread_id,
      COALESCE(thread.space_id, project.space_id, '${PERSONAL_SPACE_ID}'),
      '${CHATS_FOLDER_PREFIX}' || COALESCE(
        thread.space_id,
        project.space_id,
        '${PERSONAL_SPACE_ID}'
      )
    FROM projection_threads AS thread
    JOIN projection_projects AS project ON project.project_id = thread.project_id
    WHERE project.project_id IN (SELECT folder_id FROM legacy_chat_containers)
  `);

  // Prefer an existing active Chats folder in a Space. The deterministic migration
  // folder is used only when the user has not already created one.
  yield* sql.unsafe(`
    UPDATE legacy_chat_threads
    SET folder_id = COALESCE(
      (
        SELECT project.project_id
        FROM projection_projects AS project
        WHERE project.space_id = legacy_chat_threads.space_id
          AND project.title = 'Chats'
          AND project.kind = 'project'
          AND project.deleted_at IS NULL
        ORDER BY project.created_at, project.project_id
        LIMIT 1
      ),
      folder_id
    )
  `);

  yield* sql.unsafe(`
    INSERT OR IGNORE INTO projection_projects (
      project_id,
      kind,
      title,
      workspace_root,
      scripts_json,
      created_at,
      updated_at,
      deleted_at,
      default_model_selection_json,
      is_pinned,
      space_id,
      sidebar_sort_order,
      icon_data_url,
      archived_at
    )
    SELECT DISTINCT
      thread.folder_id,
      'project',
      'Chats',
      NULL,
      '[]',
      datetime('now'),
      datetime('now'),
      NULL,
      NULL,
      0,
      thread.space_id,
      0,
      NULL,
      NULL
    FROM legacy_chat_threads AS thread
    WHERE thread.folder_id = '${CHATS_FOLDER_PREFIX}' || thread.space_id
  `);

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
    SELECT DISTINCT
      'migration-149:create-chats-folder:' || thread.space_id,
      'folder',
      thread.folder_id,
      1,
      'folder.created',
      datetime('now'),
      NULL,
      NULL,
      NULL,
      'system',
      json_object(
        'folderId', thread.folder_id,
        'title', 'Chats',
        'workspaceRoot', json('null'),
        'defaultModelSelection', json('null'),
        'scripts', json('[]'),
        'isPinned', json('false'),
        'spaceId', thread.space_id,
        'sidebarSortOrder', 0,
        'createdAt', datetime('now'),
        'updatedAt', datetime('now')
      ),
      '{}'
    FROM legacy_chat_threads AS thread
    WHERE thread.folder_id = '${CHATS_FOLDER_PREFIX}' || thread.space_id
  `);

  yield* sql.unsafe(`
    UPDATE projection_threads
    SET project_id = (
      SELECT moved.folder_id
      FROM legacy_chat_threads AS moved
      WHERE moved.thread_id = projection_threads.thread_id
    ),
    space_id = NULL,
    updated_at = datetime('now')
    WHERE thread_id IN (SELECT thread_id FROM legacy_chat_threads)
  `);
  yield* sql.unsafe(`
    UPDATE projection_threads SET space_id = NULL
  `);

  // Managed container streams are obsolete. Their threads receive authoritative
  // layout events below, so deleting these streams does not discard thread data.
  yield* sql.unsafe(`
    DELETE FROM orchestration_events
    WHERE aggregate_kind = 'project'
      AND stream_id IN (SELECT folder_id FROM legacy_chat_containers)
  `);
  yield* sql.unsafe(`
    DELETE FROM projection_projects
    WHERE project_id IN (SELECT folder_id FROM legacy_chat_containers)
  `);

  // Rename aggregate/event vocabulary and payload keys in every surviving stream.
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET aggregate_kind = 'folder'
    WHERE aggregate_kind = 'project'
  `);
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET event_type = CASE event_type
      WHEN 'project.created' THEN 'folder.created'
      WHEN 'project.meta-updated' THEN 'folder.updated'
      WHEN 'project.deleted' THEN 'folder.deleted'
      WHEN 'space.meta-updated' THEN 'space.updated'
      WHEN 'space.order-updated' THEN 'space.updated'
      WHEN 'thread.meta-updated' THEN 'thread.updated'
      ELSE event_type
    END
  `);
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET payload_json = replace(
      replace(payload_json, '"projectId"', '"folderId"'),
      '"projectUpdates"',
      '"folderUpdates"'
    )
    WHERE instr(payload_json, 'projectId') > 0
       OR instr(payload_json, 'projectUpdates') > 0
  `);
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET payload_json = json_remove(payload_json, '$.kind')
    WHERE event_type IN ('folder.created', 'folder.updated')
  `);
  yield* sql.unsafe(`
    UPDATE orchestration_events
    SET payload_json = json_remove(payload_json, '$.spaceId')
    WHERE event_type IN ('thread.created', 'thread.updated')
  `);

  // Current folder assignments are appended as explicit moves, making a complete
  // replay independent of historical move mechanisms.
  yield* sql.unsafe(`
    WITH active_folders AS (
      SELECT
        project.project_id,
        project.space_id,
        COALESCE((
          SELECT MAX(event.stream_version)
          FROM orchestration_events AS event
          WHERE event.aggregate_kind = 'folder'
            AND event.stream_id = project.project_id
        ), 0) AS previous_stream_version
      FROM projection_projects AS project
      WHERE project.deleted_at IS NULL
        AND project.space_id IS NOT NULL
    )
    INSERT OR IGNORE INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, causation_event_id, correlation_id,
      actor_kind, payload_json, metadata_json
    )
    SELECT
      'migration-149:move-folder:' || project_id,
      'folder',
      project_id,
      previous_stream_version + 1,
      'folder.moved',
      datetime('now'),
      NULL, NULL, NULL, 'system',
      json_object(
        'folderId', project_id,
        'spaceId', space_id,
        'updatedAt', datetime('now')
      ),
      '{}'
    FROM active_folders
  `);

  yield* sql.unsafe(`
    WITH moved AS (
      SELECT
        thread.*,
        ROW_NUMBER() OVER (
          PARTITION BY thread.space_id
          ORDER BY thread.thread_id
        ) AS move_index,
        COALESCE((
          SELECT MAX(event.stream_version)
          FROM orchestration_events AS event
          WHERE event.aggregate_kind = 'space'
            AND event.stream_id = thread.space_id
        ), 0) AS previous_stream_version
      FROM legacy_chat_threads AS thread
    )
    INSERT OR IGNORE INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, causation_event_id, correlation_id,
      actor_kind, payload_json, metadata_json
    )
    SELECT
      'migration-149:file-thread:' || thread_id,
      'space',
      space_id,
      previous_stream_version + move_index,
      'sidebar.layout-updated',
      datetime('now'),
      NULL, NULL, NULL, 'system',
      json_object(
        'folderUpdates', json('[]'),
        'threadUpdates', json_array(json_object(
          'threadId', thread_id,
          'folderId', folder_id
        )),
        'updatedAt', datetime('now')
      ),
      '{}'
    FROM moved
  `);

  yield* sql.unsafe(`UPDATE projection_projects SET kind = 'project'`);
  yield* sql.unsafe(`DROP TABLE legacy_chat_threads`);
  yield* sql.unsafe(`DROP TABLE legacy_chat_containers`);
});

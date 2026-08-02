// Purpose: Makes ordinary folders pathless containers and moves legacy roots onto their threads.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Preserve replay semantics before removing roots from historical project events.
  yield* sql`
    UPDATE orchestration_events AS thread_event
    SET payload_json = json_set(
      thread_event.payload_json,
      '$.workingDirectory',
      (
        SELECT json_extract(project_event.payload_json, '$.workspaceRoot')
        FROM orchestration_events AS project_event
        WHERE project_event.stream_id = json_extract(thread_event.payload_json, '$.projectId')
          AND project_event.event_type IN ('project.created', 'project.meta-updated')
          AND json_type(project_event.payload_json, '$.workspaceRoot') = 'text'
          AND project_event.sequence <= thread_event.sequence
        ORDER BY project_event.sequence DESC
        LIMIT 1
      )
    )
    WHERE thread_event.event_type = 'thread.created'
      AND COALESCE(json_type(thread_event.payload_json, '$.workingDirectory'), 'null') = 'null'
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS created_event
        WHERE created_event.stream_id = json_extract(thread_event.payload_json, '$.projectId')
          AND created_event.event_type = 'project.created'
          AND COALESCE(json_extract(created_event.payload_json, '$.kind'), 'project') = 'project'
      )
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS project_event
        WHERE project_event.stream_id = json_extract(thread_event.payload_json, '$.projectId')
          AND project_event.event_type IN ('project.created', 'project.meta-updated')
          AND json_type(project_event.payload_json, '$.workspaceRoot') = 'text'
          AND project_event.sequence <= thread_event.sequence
      )
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.workspaceRoot', json('null'))
    WHERE event_type IN ('project.created', 'project.meta-updated')
      AND json_type(payload_json, '$.workspaceRoot') = 'text'
      AND stream_id IN (
        SELECT stream_id
        FROM orchestration_events
        WHERE event_type = 'project.created'
          AND COALESCE(json_extract(payload_json, '$.kind'), 'project') = 'project'
      )
  `;

  yield* sql`
    UPDATE projection_threads
    SET working_directory = COALESCE(
      working_directory,
      (
        SELECT project.workspace_root
        FROM projection_projects AS project
        WHERE project.project_id = projection_threads.project_id
          AND project.kind = 'project'
      )
    )
    WHERE EXISTS (
      SELECT 1
      FROM projection_projects AS project
      WHERE project.project_id = projection_threads.project_id
        AND project.kind = 'project'
        AND project.workspace_root IS NOT NULL
    )
  `;

  yield* sql`ALTER TABLE projection_projects RENAME TO projection_projects_legacy_93`;
  yield* sql`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'project',
      title TEXT NOT NULL,
      workspace_root TEXT,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      default_model_selection_json TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      space_id TEXT
    )
  `;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, kind, title, workspace_root, scripts_json,
      created_at, updated_at, deleted_at, default_model_selection_json, is_pinned, space_id
    )
    SELECT
      project_id,
      kind,
      title,
      CASE WHEN kind = 'project' THEN NULL ELSE workspace_root END,
      scripts_json,
      created_at,
      updated_at,
      deleted_at,
      default_model_selection_json,
      is_pinned,
      space_id
    FROM projection_projects_legacy_93
  `;
  yield* sql`DROP TABLE projection_projects_legacy_93`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_updated_at
    ON projection_projects(updated_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_space_id
    ON projection_projects(space_id)
  `;
});

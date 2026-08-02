import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("093_VirtualFolders", (it) => {
  it.effect("moves ordinary folder roots onto threads and makes the parent pathless", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 92 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES
          ('folder-1', 'project', 'Folder', '/repo/folder', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('studio-1', 'studio', 'Studio', '/repo/studio', '[]',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
          working_directory, create_branch_flow_completed, created_at, updated_at
        ) VALUES (
          'thread-1', 'folder-1', 'Thread', 'full-access', 'default', 'local',
          NULL, 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          ('event-project', 'project', 'folder-1', 1, 'project.created',
            '2026-01-01T00:00:00.000Z', 'system',
            '{"projectId":"folder-1","kind":"project","workspaceRoot":"/repo/folder"}', '{}'),
          ('event-thread', 'thread', 'thread-1', 1, 'thread.created',
            '2026-01-01T00:00:01.000Z', 'system',
            '{"threadId":"thread-1","projectId":"folder-1","workingDirectory":null}', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 93 });

      const projects = yield* sql<{
        readonly project_id: string;
        readonly workspace_root: string | null;
      }>`SELECT project_id, workspace_root FROM projection_projects ORDER BY project_id`;
      assert.deepStrictEqual(projects, [
        { project_id: "folder-1", workspace_root: null },
        { project_id: "studio-1", workspace_root: "/repo/studio" },
      ]);
      const threads = yield* sql<{ readonly working_directory: string | null }>`
        SELECT working_directory FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.strictEqual(threads[0]?.working_directory, "/repo/folder");
      const events = yield* sql<{ readonly event_type: string; readonly payload_json: string }>`
        SELECT event_type, payload_json
        FROM orchestration_events
        WHERE event_id IN ('event-project', 'event-thread')
        ORDER BY sequence
      `;
      assert.strictEqual(JSON.parse(events[0]!.payload_json).workspaceRoot, null);
      assert.strictEqual(JSON.parse(events[1]!.payload_json).workingDirectory, "/repo/folder");
    }),
  );
});

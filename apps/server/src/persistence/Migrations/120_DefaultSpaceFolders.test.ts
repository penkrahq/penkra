import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("120_DefaultSpaceFolders", (it) => {
  it.effect("creates Untitled only for Spaces with loose threads and files those threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 119 });

      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES
          ('space-with-thread', 'With thread', 'folder', 0,
            '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
          ('empty-space', 'Empty', 'folder', 1,
            '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('legacy-chat', 'chat', 'Home', '/tmp/home', '[]',
          '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, space_id, title, runtime_mode, env_mode, created_at, updated_at
        ) VALUES ('loose-thread', 'legacy-chat', 'space-with-thread', 'Loose',
          'full-access', 'local', '2026-08-14T00:00:01.000Z', '2026-08-14T00:00:01.000Z')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES ('space-event', 'space', 'space-with-thread', 1, 'space.created',
          '2026-08-14T00:00:00.000Z', 'system', '{}', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 120 });

      const createdFolders = yield* sql<{
        readonly streamId: string;
        readonly payload: string;
      }>`
        SELECT stream_id AS "streamId", payload_json AS payload
        FROM orchestration_events
        WHERE event_type = 'project.created' AND event_id LIKE 'migration-120:%'
      `;
      assert.strictEqual(createdFolders.length, 1);
      assert.strictEqual(createdFolders[0]?.streamId, "penkra-default-folder:space-with-thread");
      assert.deepStrictEqual(JSON.parse(createdFolders[0]!.payload), {
        projectId: "penkra-default-folder:space-with-thread",
        kind: "project",
        title: "Untitled",
        workspaceRoot: null,
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        spaceId: "space-with-thread",
        sidebarSortOrder: 0,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      });

      const moves = yield* sql<{ readonly streamVersion: number; readonly payload: string }>`
        SELECT stream_version AS "streamVersion", payload_json AS payload
        FROM orchestration_events
        WHERE event_id = 'migration-120:file-thread:loose-thread'
      `;
      assert.strictEqual(moves[0]?.streamVersion, 2);
      assert.deepStrictEqual(JSON.parse(moves[0]!.payload).threadUpdates, [
        {
          threadId: "loose-thread",
          projectId: "penkra-default-folder:space-with-thread",
          spaceId: null,
        },
      ]);
    }),
  );
});

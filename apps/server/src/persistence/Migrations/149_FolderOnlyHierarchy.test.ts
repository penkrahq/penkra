import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("149_FolderOnlyHierarchy", (it) => {
  it.effect("files legacy chat threads and rewrites the authoritative vocabulary", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 148 });
      const now = "2026-08-22T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES ('migration-space', 'Migration', 'folder', 50, ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json,
          created_at, updated_at, space_id
        ) VALUES ('legacy-home', 'chat', 'Home', '/tmp/home', '[]', ${now}, ${now}, NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, space_id, title, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'legacy-thread', 'legacy-home', 'migration-space', 'Legacy',
          'full-access', ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'legacy-home-created', 'project', 'legacy-home', 1, 'project.created',
            ${now}, 'system',
            '{"projectId":"legacy-home","kind":"chat","title":"Home","workspaceRoot":"/tmp/home","defaultModelSelection":null,"scripts":[],"spaceId":null,"createdAt":"2026-08-22T00:00:00.000Z","updatedAt":"2026-08-22T00:00:00.000Z"}',
            '{}'
          ),
          (
            'legacy-thread-created', 'thread', 'legacy-thread', 1, 'thread.created',
            ${now}, 'system',
            '{"threadId":"legacy-thread","projectId":"legacy-home","spaceId":"migration-space","title":"Legacy","modelSelection":{"provider":"codex","model":"gpt-5.5"},"runtimeMode":"full-access","createdAt":"2026-08-22T00:00:00.000Z","updatedAt":"2026-08-22T00:00:00.000Z"}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 149 });

      const threadRows = yield* sql<{
        readonly folderId: string;
        readonly spaceId: string | null;
      }>`
        SELECT project_id AS "folderId", space_id AS "spaceId"
        FROM projection_threads
        WHERE thread_id = 'legacy-thread'
      `;
      assert.deepStrictEqual(threadRows, [
        { folderId: "penkra-chats-folder:migration-space", spaceId: null },
      ]);

      const legacyContainers = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_projects WHERE project_id = 'legacy-home'
      `;
      assert.strictEqual(legacyContainers[0]?.count, 0);

      const chatFolders = yield* sql<{
        readonly title: string;
        readonly spaceId: string;
      }>`
        SELECT title, space_id AS "spaceId"
        FROM projection_projects
        WHERE project_id = 'penkra-chats-folder:migration-space'
      `;
      assert.deepStrictEqual(chatFolders, [{ title: "Chats", spaceId: "migration-space" }]);

      const createdThreadPayload = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload
        FROM orchestration_events
        WHERE event_id = 'legacy-thread-created'
      `;
      assert.deepStrictEqual(JSON.parse(createdThreadPayload[0]!.payload), {
        threadId: "legacy-thread",
        folderId: "legacy-home",
        title: "Legacy",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        runtimeMode: "full-access",
        createdAt: now,
        updatedAt: now,
      });

      const moveEvents = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload
        FROM orchestration_events
        WHERE event_id = 'migration-149:file-thread:legacy-thread'
      `;
      assert.deepStrictEqual(JSON.parse(moveEvents[0]!.payload).threadUpdates, [
        { threadId: "legacy-thread", folderId: "penkra-chats-folder:migration-space" },
      ]);
    }),
  );
});

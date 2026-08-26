import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("151_FolderPersistenceNames", (it) => {
  it.effect("moves the active read model to Folder vocabulary without losing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 150 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json,
          created_at, updated_at, default_model_selection_json,
          is_pinned, space_id, sidebar_sort_order
        ) VALUES (
          'folder-151', 'project', 'Folder', NULL, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
          0, 'space-151', 0
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, space_id, title, model_selection_json,
          runtime_mode, created_at, updated_at
        ) VALUES (
          'thread-151', 'folder-151', 'space-151', 'Thread',
          '{"provider":"codex","model":"test-model"}', 'full-access',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 151 });

      const folders = yield* sql<{ readonly folderId: string }>`
        SELECT folder_id AS "folderId" FROM projection_folders
      `;
      const threads = yield* sql<{ readonly folderId: string }>`
        SELECT folder_id AS "folderId" FROM projection_threads
      `;
      const legacyTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_projects'
      `;
      assert.deepStrictEqual(folders, [{ folderId: "folder-151" }]);
      assert.deepStrictEqual(threads, [{ folderId: "folder-151" }]);
      assert.deepStrictEqual(legacyTables, []);
    }),
  );
});

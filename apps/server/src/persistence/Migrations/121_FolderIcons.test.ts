import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("121_FolderIcons", (it) => {
  it.effect("adds nullable custom icon storage without changing existing folders", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 120 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('folder', 'project', 'Folder', NULL, '[]',
          '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 121 });
      const before = yield* sql<{ readonly iconDataUrl: string | null }>`
        SELECT icon_data_url AS "iconDataUrl"
        FROM projection_projects
        WHERE project_id = 'folder'
      `;
      assert.strictEqual(before[0]?.iconDataUrl, null);

      yield* sql`
        UPDATE projection_projects
        SET icon_data_url = 'data:image/webp;base64,Y3VzdG9t'
        WHERE project_id = 'folder'
      `;
      const after = yield* sql<{ readonly iconDataUrl: string | null }>`
        SELECT icon_data_url AS "iconDataUrl"
        FROM projection_projects
        WHERE project_id = 'folder'
      `;
      assert.strictEqual(after[0]?.iconDataUrl, "data:image/webp;base64,Y3VzdG9t");
    }),
  );
});

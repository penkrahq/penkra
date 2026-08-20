import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("133_ReclassifiedFolderSpaces", (it) => {
  it.effect("repairs folders that migration 129 reclassified after Spaces became required", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 128 });
      const now = "2026-08-19T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, kind, space_id
        ) VALUES (
          'studio-folder', 'Studio', NULL, NULL, '[]', ${now}, ${now}, 'studio', NULL
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'studio-folder-created', 'project', 'studio-folder', 1, 'project.created', ${now},
          'system', '{"projectId":"studio-folder","kind":"studio","spaceId":null}', '{}'
        )
      `;

      // Reproduce an already-upgraded database: 129 reclassifies the row, while 130-132 do not
      // repair the Space assignment.
      yield* runMigrations({ toMigrationInclusive: 132 });
      const before = yield* sql<{ readonly kind: string; readonly spaceId: string | null }>`
        SELECT kind, space_id AS "spaceId"
        FROM projection_projects
        WHERE project_id = 'studio-folder'
      `;
      assert.deepStrictEqual(before, [{ kind: "project", spaceId: null }]);

      yield* runMigrations({ toMigrationInclusive: 133 });
      const after = yield* sql<{ readonly spaceId: string }>`
        SELECT space_id AS "spaceId"
        FROM projection_projects
        WHERE project_id = 'studio-folder'
      `;
      assert.deepStrictEqual(after, [{ spaceId: "penkra-personal" }]);
      const events = yield* sql<{ readonly spaceId: string }>`
        SELECT json_extract(payload_json, '$.spaceId') AS "spaceId"
        FROM orchestration_events
        WHERE stream_id = 'studio-folder' AND event_type = 'project.created'
      `;
      assert.deepStrictEqual(events, [{ spaceId: "penkra-personal" }]);
    }),
  );
});

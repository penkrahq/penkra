import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("103_DefaultNewSpacesAndConnections", (it) => {
  it.effect("persists the first active Connection for existing and future Spaces", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES (
          'space-before', 'Personal', '', 0,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, created_at, updated_at
        ) VALUES (
          'connection-1', 'opencode', 'opencode-go', 'api-key',
          'Go', 'provider-secret:connection-1', 'active',
          '2026-08-08T00:01:00.000Z', '2026-08-08T00:01:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES (
          'space-after', 'Work', '', 1,
          '2026-08-08T00:02:00.000Z', '2026-08-08T00:02:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, created_at, updated_at
        ) VALUES (
          'connection-2', 'opencode', 'opencode-go', 'api-key',
          'Second', 'provider-secret:connection-2', 'active',
          '2026-08-08T00:03:00.000Z', '2026-08-08T00:03:00.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly space_id: string;
        readonly connection_id: string;
      }>`
        SELECT space_id, connection_id
        FROM space_connection_defaults
        ORDER BY space_id
      `;
      assert.deepStrictEqual(rows, [
        { space_id: "space-after", connection_id: "connection-1" },
        { space_id: "space-before", connection_id: "connection-1" },
      ]);
    }),
  );
});

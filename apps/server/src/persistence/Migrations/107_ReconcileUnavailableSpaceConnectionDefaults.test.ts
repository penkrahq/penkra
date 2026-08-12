import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("107_ReconcileUnavailableSpaceConnectionDefaults", (it) => {
  it.effect("removes an unavailable default and assigns the next added Connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 106 });
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES (
          'space-1', 'Personal', '', 0,
          '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, created_at, updated_at
        ) VALUES (
          'connection-old', 'opencode', 'opencode-go', 'api-key',
          'Old', 'provider-secret:connection-old', 'active',
          '2026-08-09T00:01:00.000Z', '2026-08-09T00:01:00.000Z'
        )
      `;
      yield* sql`
        UPDATE provider_connections
        SET lifecycle = 'terminated', termination_reason = 'disconnected',
            terminated_at = '2026-08-09T00:02:00.000Z',
            updated_at = '2026-08-09T00:02:00.000Z'
        WHERE connection_id = 'connection-old'
      `;

      yield* runMigrations({ toMigrationInclusive: 107 });

      const afterRepair = yield* sql<{ readonly connectionId: string }>`
        SELECT connection_id AS "connectionId" FROM space_connection_defaults
      `;
      assert.deepStrictEqual(afterRepair, []);

      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, created_at, updated_at
        ) VALUES (
          'connection-next', 'opencode', 'opencode-go', 'api-key',
          'Next', 'provider-secret:connection-next', 'active',
          '2026-08-09T00:03:00.000Z', '2026-08-09T00:03:00.000Z'
        )
      `;

      const afterCreate = yield* sql<{ readonly connectionId: string }>`
        SELECT connection_id AS "connectionId" FROM space_connection_defaults
      `;
      assert.deepStrictEqual(afterCreate, [{ connectionId: "connection-next" }]);
    }),
  );

  it.effect("chooses the newest remaining active Connection when a default disconnects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 107 });
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at
        ) VALUES (
          'space-2', 'Work', '', 0,
          '2026-08-09T01:00:00.000Z', '2026-08-09T01:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, created_at, updated_at
        ) VALUES
          ('connection-a', 'claudeAgent', 'anthropic-first-party', 'api-key',
           'A', 'provider-secret:connection-a', 'active',
           '2026-08-09T01:01:00.000Z', '2026-08-09T01:01:00.000Z'),
          ('connection-b', 'claudeAgent', 'anthropic-first-party', 'api-key',
           'B', 'provider-secret:connection-b', 'active',
           '2026-08-09T01:02:00.000Z', '2026-08-09T01:02:00.000Z')
      `;
      yield* sql`
        UPDATE space_connection_defaults
        SET connection_id = 'connection-b', updated_at = '2026-08-09T01:02:00.000Z'
        WHERE space_id = 'space-2' AND harness_kind = 'claudeAgent'
      `;
      yield* sql`
        UPDATE provider_connections
        SET lifecycle = 'terminated', termination_reason = 'disconnected',
            terminated_at = '2026-08-09T01:03:00.000Z',
            updated_at = '2026-08-09T01:03:00.000Z'
        WHERE connection_id = 'connection-b'
      `;

      const rows = yield* sql<{ readonly connectionId: string }>`
        SELECT connection_id AS "connectionId"
        FROM space_connection_defaults
        WHERE space_id = 'space-2' AND harness_kind = 'claudeAgent'
      `;
      assert.deepStrictEqual(rows, [{ connectionId: "connection-a" }]);
    }),
  );
});

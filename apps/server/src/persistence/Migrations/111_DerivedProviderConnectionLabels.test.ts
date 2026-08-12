import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("111_DerivedProviderConnectionLabels", (it) => {
  it.effect("allows distinct Connections to share a derived display label", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 110 });
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, created_at, updated_at
        ) VALUES (
          'connection-1', 'opencode', 'opencode-go', 'api-key',
          'OpenCode Go / ••••A7F2', 'provider-secret:connection-1', 'active',
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;
      assert.strictEqual(
        (yield* Effect.exit(sql`
          INSERT INTO provider_connections (
            connection_id, harness_kind, authentication_target_id, authentication_method_id,
            label, credential_ref, lifecycle, created_at, updated_at
          ) VALUES (
            'connection-2', 'opencode', 'opencode-go', 'api-key',
            'OpenCode Go / ••••A7F2', 'provider-secret:connection-2', 'active',
            '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
          )
        `))._tag,
        "Failure",
      );

      yield* runMigrations({ toMigrationInclusive: 111 });
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, created_at, updated_at
        ) VALUES (
          'connection-2', 'opencode', 'opencode-go', 'api-key',
          'OpenCode Go / ••••A7F2', 'provider-secret:connection-2', 'active',
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;

      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM provider_connections
        WHERE label = 'OpenCode Go / ••••A7F2'
      `;
      assert.deepStrictEqual(rows, [{ count: 2 }]);
    }),
  );
});

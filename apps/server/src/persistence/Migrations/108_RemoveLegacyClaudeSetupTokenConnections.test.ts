import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("108_RemoveLegacyClaudeSetupTokenConnections", (it) => {
  it.effect("journals only the retired setup-token backend for secure removal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 107 });
      yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, credential_ref, lifecycle, termination_reason, terminated_at, created_at, updated_at
        ) VALUES
          ('legacy-claude', 'claudeAgent', 'anthropic-first-party', 'subscription-token',
           'Legacy', 'provider-secret:legacy-claude', 'active', NULL, NULL,
           '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'),
          ('terminated-legacy-claude', 'claudeAgent', 'anthropic-first-party', 'subscription-token',
           'Old Legacy', 'provider-secret:terminated-legacy-claude', 'terminated', 'disconnected',
           '2026-08-09T00:00:00.000Z',
           '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z'),
          ('claude-api', 'claudeAgent', 'anthropic-first-party', 'api-key',
           'API', 'provider-secret:claude-api', 'active', NULL, NULL,
           '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 108 });

      const rows = yield* sql<{
        readonly connectionId: string;
        readonly kind: string;
        readonly state: string;
      }>`
        SELECT connection_id AS "connectionId", operation_kind AS kind,
               operation_state AS state
        FROM provider_connection_operations
        ORDER BY connection_id
      `;
      assert.deepStrictEqual(rows, [
        { connectionId: "legacy-claude", kind: "terminate", state: "pending" },
        { connectionId: "terminated-legacy-claude", kind: "terminate", state: "pending" },
      ]);
    }),
  );
});

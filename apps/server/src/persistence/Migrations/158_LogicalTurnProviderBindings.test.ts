import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("158_LogicalTurnProviderBindings", (it) => {
  it.effect("backfills provider identities and allows logical turn aliases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 157 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, pending_message_id,
          assistant_message_id, state, requested_at, started_at, completed_at
        ) VALUES (
          'thread-provider-bindings', 'turn-logical-original', 'turn-provider-native',
          'message-logical-original', NULL, 'running',
          '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:01.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 158 });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, provider_turn_id, pending_message_id,
          assistant_message_id, state, requested_at, started_at, completed_at
        ) VALUES (
          'thread-provider-bindings', 'turn-logical-steer', 'turn-provider-native',
          'message-logical-steer', NULL, 'running',
          '2026-09-05T00:00:02.000Z', '2026-09-05T00:00:02.000Z', NULL
        )
      `;
      const bindings = yield* sql<{
        readonly turnId: string;
        readonly providerTurnId: string;
      }>`
        SELECT turn_id AS "turnId", provider_turn_id AS "providerTurnId"
        FROM projection_turn_provider_bindings
        ORDER BY turn_id ASC
      `;
      assert.deepStrictEqual(bindings, [
        { turnId: "turn-logical-original", providerTurnId: "turn-provider-native" },
      ]);
    }),
  );
});

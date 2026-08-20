import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("124_CanonicalOperations", (it) => {
  it.effect("supports namespaced operations and terminal lifecycle states", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 124 });
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, turn_id, provider,
          item_type, status, started_at, last_source_event_id, updated_at
        ) VALUES (
          'codex:thread:turn:call', 'call', 'thread', 'turn', 'codex',
          'command_execution', 'aborted', '2026-08-19T00:00:00.000Z', 'event',
          '2026-08-19T00:00:01.000Z'
        )
      `;
      const rows = yield* sql<{ readonly status: string }>`SELECT status FROM operations`;
      assert.deepStrictEqual(rows, [{ status: "aborted" }]);
    }),
  );
});

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("140_RemoveRedundantOperationDetail", (it) => {
  it.effect("removes the duplicate envelope while preserving canonical activity reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 139 });
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, turn_id, provider, item_type,
          title, status, input_json, detail_json, activity_json, started_at, ended_at,
          last_source_event_id, updated_at
        ) VALUES (
          'operation-1', 'provider-1', 'thread-1', 'turn-1', 'codex', 'dynamic_tool_call',
          'Search', 'completed', '{"query":"TODO"}', '{"duplicated":true}',
          '{"tone":"tool","kind":"tool.completed","summary":"Searched","payload":{"detail":"done"}}',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:01.000Z', 'event-1',
          '2026-08-19T00:00:01.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 140 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('operations')
      `;
      assert.notInclude(
        columns.map(({ name }) => name),
        "detail_json",
      );
      const rows = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_activities_read WHERE activity_id = 'operation-1'
      `;
      assert.deepStrictEqual(JSON.parse(rows[0]!.payload), { detail: "done" });
    }),
  );
});

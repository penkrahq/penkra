import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("138_CanonicalActivityReadModel", (it) => {
  it.effect("cuts reads over without duplicating pre-cutover activity history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 137 });
      // This migration test isolates the activity tables; parent Thread rows are irrelevant.
      yield* sql`PRAGMA foreign_keys = OFF`;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'legacy-tool', 'thread-read-model', 'turn-read-model', 'tool', 'tool.completed',
          'Legacy tool', '{"operationId":"provider-tool"}', 1, '2026-08-19T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, turn_id, provider, item_type,
          title, status, input_json, detail_json, started_at, ended_at,
          last_source_event_id, updated_at
        ) VALUES (
          'stale-operation', 'provider-tool', 'thread-read-model', 'turn-read-model', 'codex',
          'dynamic_tool_call', 'Legacy tool', 'completed', NULL, '{}',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:01.000Z',
          'stale-event', '2026-08-19T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO notices (
          notice_id, thread_id, turn_id, kind, tone, summary, detail_json, created_at
        ) VALUES (
          'stale-notice', 'thread-read-model', NULL, 'runtime.warning', 'warning',
          'Legacy warning', '{}', '2026-08-19T00:00:01.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 138 });
      assert.deepStrictEqual(yield* sql`SELECT operation_id FROM operations`, []);
      assert.deepStrictEqual(yield* sql`SELECT notice_id FROM notices`, []);
      assert.deepStrictEqual(
        yield* sql`
          SELECT activity_id AS "activityId", kind
          FROM thread_activities_read
          ORDER BY activity_id
        `,
        [{ activityId: "legacy-tool", kind: "tool.completed" }],
      );

      yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, turn_id, provider, item_type,
          title, status, input_json, detail_json, activity_json, started_at, ended_at,
          last_source_event_id, updated_at
        ) VALUES (
          'canonical-operation', 'provider-new', 'thread-read-model', 'turn-read-model', 'codex',
          'dynamic_tool_call', 'New tool', 'running', '{"path":"TODO.md"}', '{}',
          '{"tone":"tool","kind":"tool.updated","summary":"New tool","payload":{"operationId":"provider-new"}}',
          '2026-08-19T00:00:02.000Z', NULL, 'new-event', '2026-08-19T00:00:02.000Z'
        )
      `;
      yield* sql`
        INSERT INTO notices (
          notice_id, thread_id, turn_id, kind, tone, summary, detail_json, created_at
        ) VALUES (
          'canonical-notice', 'thread-read-model', NULL, 'runtime.warning', 'warning',
          'New warning', '{"message":"New warning"}', '2026-08-19T00:00:03.000Z'
        )
      `;
      assert.deepStrictEqual(
        yield* sql`
          SELECT activity_id AS "activityId", kind, summary
          FROM thread_activities_read
          ORDER BY created_at, activity_id
        `,
        [
          { activityId: "legacy-tool", kind: "tool.completed", summary: "Legacy tool" },
          { activityId: "canonical-operation", kind: "tool.updated", summary: "New tool" },
          { activityId: "canonical-notice", kind: "runtime.warning", summary: "New warning" },
        ],
      );
    }),
  );
});

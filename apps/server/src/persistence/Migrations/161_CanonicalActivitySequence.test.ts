import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./161_CanonicalActivitySequence.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
layer("161_CanonicalActivitySequence", (it) => {
  it.effect(
    "recovers only exact accepted receipt sequences without deleting canonical history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 160 });
        // Isolate migration of activity identities from unrelated parent Thread fixtures.
        yield* sql`PRAGMA foreign_keys = OFF`;
        yield* sql`
        INSERT INTO operations (
          operation_id, provider_operation_id, thread_id, turn_id, provider, item_type,
          title, status, input_json, activity_json, started_at, ended_at,
          last_source_event_id, updated_at
        ) VALUES (
          'operation-1', 'provider-tool', 'thread-sequence', NULL, 'codex', 'dynamic_tool_call',
          'Tool', 'completed', NULL,
          '{"tone":"tool","kind":"tool.completed","summary":"Tool","payload":{}}',
          '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:01.000Z',
          'source-event', '2026-09-07T00:00:01.000Z'
        )
      `;
        for (const id of ["accepted", "rejected", "wrong-thread", "missing"]) {
          yield* sql`
          INSERT INTO notices (notice_id, thread_id, turn_id, kind, tone, summary, detail_json, created_at)
          VALUES (${id}, 'thread-sequence', NULL, 'runtime.warning', 'error', ${id}, '{}', '2026-09-07T00:00:02.000Z')
        `;
        }
        for (const [source, sequence, status, owner] of [
          ["source-event", 8, "accepted", "thread-sequence"],
          ["accepted", 9, "accepted", "thread-sequence"],
          ["rejected", 10, "rejected", "thread-sequence"],
          ["wrong-thread", 11, "accepted", "other-thread"],
        ] as const) {
          yield* sql`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
          ) VALUES (
            ${"provider:" + source + ":activity-read-model-touch:thread-sequence"},
            'thread', ${owner}, '2026-09-07T00:00:02.000Z', ${sequence}, ${status}, NULL
          )
        `;
        }
        yield* runMigrations();
        // Once retained, sequence evidence survives migration replay even if the
        // accepted-command receipt has since aged out of retention.
        yield* sql`DELETE FROM orchestration_command_receipts`;
        yield* migration;

        assert.deepEqual(
          yield* sql`
        SELECT activity_id AS id, sequence FROM thread_activities_read
        WHERE thread_id = 'thread-sequence' ORDER BY activity_id
      `,
          [
            { id: "accepted", sequence: 9 },
            { id: "missing", sequence: null },
            { id: "operation-1", sequence: 8 },
            { id: "rejected", sequence: null },
            { id: "wrong-thread", sequence: null },
          ],
        );
      }),
  );
});

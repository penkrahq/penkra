import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("106_RemovePlanMode", (it) => {
  it.effect("preserves plan text as a message and removes the special schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 105 });

      yield* sql.unsafe(`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at,
          implementation_thread_id, created_at, updated_at
        ) VALUES (
          'plan-1', 'thread-1', 'turn-1', '## Preserved plan', NULL,
          NULL, '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:01.000Z'
        )
      `);
      yield* sql.unsafe(`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-plan-1', 'thread', 'thread-1', 1, 'thread.proposed-plan-upserted',
          '2026-08-08T00:00:01.000Z', 'provider',
          '{"threadId":"thread-1","proposedPlan":{"id":"plan-1","turnId":"turn-1","planMarkdown":"## Preserved plan","implementedAt":null,"implementationThreadId":null,"createdAt":"2026-08-08T00:00:00.000Z","updatedAt":"2026-08-08T00:00:01.000Z"}}',
          '{}'
        )
      `);
      yield* sql.unsafe(`
        INSERT INTO provider_runtime_events (
          event_id, thread_id, turn_id, event_type, event_json, persisted_at
        ) VALUES (
          'runtime-plan-1', 'thread-1', 'turn-1', 'turn.proposed.completed', '{}',
          '2026-08-08T00:00:01.000Z'
        )
      `);

      yield* runMigrations({ toMigrationInclusive: 106 });

      const messages = yield* sql.unsafe<{
        readonly message_id: string;
        readonly text: string;
      }>(`SELECT message_id, text FROM projection_thread_messages WHERE thread_id = 'thread-1'`);
      assert.deepStrictEqual(messages, [
        { message_id: "legacy-proposed-plan:plan-1", text: "## Preserved plan" },
      ]);

      const events = yield* sql.unsafe<{
        readonly event_type: string;
        readonly role: string;
        readonly text: string;
      }>(`
        SELECT event_type,
          json_extract(payload_json, '$.role') AS role,
          json_extract(payload_json, '$.text') AS text
        FROM orchestration_events
        WHERE event_id = 'event-plan-1'
      `);
      assert.deepStrictEqual(events, [
        { event_type: "thread.message-sent", role: "assistant", text: "## Preserved plan" },
      ]);

      const threadColumns = yield* sql.unsafe<{ readonly name: string }>(
        `SELECT name FROM pragma_table_info('projection_threads')`,
      );
      assert.isFalse(threadColumns.some((column) => column.name === "interaction_mode"));
      assert.isFalse(
        threadColumns.some((column) => column.name === "has_actionable_proposed_plan"),
      );
      const turnColumns = yield* sql.unsafe<{ readonly name: string }>(
        `SELECT name FROM pragma_table_info('projection_turns')`,
      );
      assert.isFalse(
        turnColumns.some((column) => column.name === "source_proposed_plan_thread_id"),
      );
      assert.isFalse(turnColumns.some((column) => column.name === "source_proposed_plan_id"));

      const proposalTables = yield* sql.unsafe<{ readonly count: number }>(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_proposed_plans'
      `);
      assert.strictEqual(proposalTables[0]?.count, 0);
      const runtimeRows = yield* sql.unsafe<{ readonly count: number }>(`
        SELECT COUNT(*) AS count FROM provider_runtime_events
        WHERE event_type LIKE 'turn.proposed.%'
      `);
      assert.strictEqual(runtimeRows[0]?.count, 0);
    }),
  );
});

import { ProviderConnectionId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ConnectionUsageFactRepository } from "../Services/ConnectionUsageFacts.ts";
import { ConnectionUsageFactRepositoryLive } from "./ConnectionUsageFacts.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(sqlLayer, ConnectionUsageFactRepositoryLive.pipe(Layer.provide(sqlLayer))),
);

layer("ConnectionUsageFactRepository", (it) => {
  it.effect("upserts a provider-owned rate-limit fact", () =>
    Effect.gen(function* () {
      const repository = yield* ConnectionUsageFactRepository;
      yield* runMigrations();
      yield* repository.putRateLimits({
        connectionId: ProviderConnectionId.makeUnsafe("codex-login"),
        provider: "codex",
        limitsJson: '{"rateLimits":{"primary":{"usedPercent":12}}}',
        status: null,
        sourceEventId: "provider-login:operation-1",
        updatedAt: "2026-08-21T12:00:00.000Z",
      });

      const fact = yield* repository.getRateLimits(ProviderConnectionId.makeUnsafe("codex-login"));
      assert.strictEqual(Option.getOrNull(fact)?.sourceEventId, "provider-login:operation-1");
    }),
  );

  it.effect("reads the latest materialized rate-limit fact for one Connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ConnectionUsageFactRepository;
      yield* runMigrations();
      yield* sql`
        INSERT INTO connection_rate_limits (
          connection_id, provider, limits_json, status, last_source_event_id, updated_at
        ) VALUES (
          'codex-account', 'codex', '{"primary":{"usedPercent":38}}', NULL,
          'event-1', '2026-08-21T12:00:00.000Z'
        )
      `;

      const fact = yield* repository.getRateLimits(
        ProviderConnectionId.makeUnsafe("codex-account"),
      );
      assert.deepStrictEqual(Option.getOrNull(fact), {
        connectionId: ProviderConnectionId.makeUnsafe("codex-account"),
        provider: "codex",
        limitsJson: '{"primary":{"usedPercent":38}}',
        status: null,
        sourceEventId: "event-1",
        updatedAt: "2026-08-21T12:00:00.000Z",
      });
    }),
  );

  it.effect("reads connection-scoped daily usage within the requested window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ConnectionUsageFactRepository;
      yield* runMigrations();
      yield* sql`
        INSERT INTO connection_usage_daily (
          utc_day, connection_id, provider, input_tokens, output_tokens,
          reasoning_output_tokens, turns, updated_at
        ) VALUES
          ('2026-07-01', 'claude-account', 'claudeAgent', 10, 2, 0, 1,
           '2026-07-01T12:00:00.000Z'),
          ('2026-08-23', 'claude-account', 'claudeAgent', 500, 40, 0, 3,
           '2026-08-23T12:00:00.000Z')
      `;

      const rows = yield* repository.listDailyUsage({
        connectionId: ProviderConnectionId.makeUnsafe("claude-account"),
        sinceUtcDay: "2026-08-01",
      });
      assert.deepStrictEqual(rows, [
        {
          utcDay: "2026-08-23",
          connectionId: ProviderConnectionId.makeUnsafe("claude-account"),
          provider: "claudeAgent",
          inputTokens: 500,
          outputTokens: 40,
          reasoningOutputTokens: 0,
          turns: 3,
          updatedAt: "2026-08-23T12:00:00.000Z",
        },
      ]);
    }),
  );
});

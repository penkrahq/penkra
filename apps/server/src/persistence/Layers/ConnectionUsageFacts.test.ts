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
});

import { assert, it } from "@effect/vitest";
import { ProviderConnectionId } from "@penkra/contracts";
import { Effect, Layer, PubSub } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderAuthCircuits, ProviderAuthCircuitsLive } from "./providerAuthCircuit.ts";

const failure = {
  kind: "provider-rejected" as const,
  summary: "Provider temporarily unavailable.",
  detail: "401 Incorrect API key provided",
};
const now = "2026-09-25T23:00:00.000Z";
const provideCircuits = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(ProviderAuthCircuitsLive), Effect.provide(SqlitePersistenceMemory));

it.effect(
  "blocks on auth failure without advancing the fake clock; explicit retry releases it",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const circuits = yield* ProviderAuthCircuits;
      const connectionId = ProviderConnectionId.makeUnsafe("auth-circuit-fixture");
      yield* sql`
      INSERT INTO provider_connections (
        connection_id, harness_kind, authentication_target_id, authentication_method_id,
        label, profile_ref, created_at, updated_at
      ) VALUES (${connectionId}, 'codex', 'openai-first-party', 'chatgpt',
                'Fixture', 'fixture-profile', ${now}, ${now})
    `;
      yield* circuits.open({ connectionId, failure, now });
      yield* circuits.open({ connectionId, failure, now });
      const opened = (yield* circuits.get(connectionId))[0]!;
      assert.strictEqual(opened.failureCount, 1);
      assert.strictEqual(opened.profileRef, "fixture-profile");
      assert.strictEqual(opened.detail, failure.detail);
      const freshLifetime = yield* Effect.gen(function* () {
        const restarted = yield* ProviderAuthCircuits;
        return yield* restarted.get(connectionId);
      }).pipe(Effect.provide(Layer.fresh(ProviderAuthCircuitsLive)));
      assert.lengthOf(freshLifetime, 0);
      assert.lengthOf(yield* circuits.get(connectionId), 1);
      yield* circuits.recordFailedProbe(connectionId);
      assert.strictEqual((yield* circuits.get(connectionId))[0]?.failureCount, 2);
      yield* circuits.close(connectionId);
      assert.lengthOf(yield* circuits.get(connectionId), 0);
    }).pipe(provideCircuits),
);

it.effect("a replacement profile releases the previous auth block", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const circuits = yield* ProviderAuthCircuits;
    const connectionId = ProviderConnectionId.makeUnsafe("profile-circuit-fixture");
    yield* sql`
      INSERT INTO provider_connections (
        connection_id, harness_kind, authentication_target_id, authentication_method_id,
        label, profile_ref, created_at, updated_at
      ) VALUES (${connectionId}, 'codex', 'openai-first-party', 'chatgpt',
                'Fixture', 'old-profile', ${now}, ${now})
    `;
    yield* circuits.open({ connectionId, failure, now });
    assert.lengthOf(yield* circuits.get(connectionId), 1);
    const releases = yield* circuits.subscribeReleases;
    yield* sql`UPDATE provider_connections SET profile_ref = 'new-profile' WHERE connection_id = ${connectionId}`;
    assert.lengthOf(yield* circuits.get(connectionId), 0);
    assert.strictEqual((yield* PubSub.take(releases)).connectionId, connectionId);
  }).pipe(provideCircuits),
);

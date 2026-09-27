import { assert, it } from "@effect/vitest";
import { ProviderConnectionId } from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderAuthCircuitStore, nextAuthProbeAt } from "./providerAuthCircuit.ts";

it.effect("opens once, backs off, and closes the durable Connection circuit", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const circuits = makeProviderAuthCircuitStore(sql);
    const connectionId = ProviderConnectionId.makeUnsafe("auth-circuit-fixture");
    const now = "2026-09-25T23:00:00.000Z";
    yield* sql`
      INSERT INTO provider_connections (
        connection_id, harness_kind, authentication_target_id, authentication_method_id,
        label, profile_ref, created_at, updated_at
      ) VALUES (${connectionId}, 'codex', 'openai-first-party', 'chatgpt',
                'Fixture', 'fixture-profile', ${now}, ${now})
    `;
    const failure = {
      kind: "provider-rejected" as const,
      summary: "Provider temporarily unavailable.",
      detail: "401 Incorrect API key provided: sk-svcac…",
    };
    yield* circuits.open({ connectionId, failure, now });
    yield* circuits.open({ connectionId, failure, now });
    const opened = (yield* circuits.get(connectionId))[0]!;
    assert.strictEqual(opened.failureCount, 1);
    assert.strictEqual(opened.profileRef, "fixture-profile");
    assert.strictEqual(opened.nextProbeAt, "2026-09-25T23:00:10.000Z");
    yield* sql`UPDATE provider_connections SET profile_ref = 'new-profile' WHERE connection_id = ${connectionId}`;
    const reauthenticated = yield* circuits.listDue("2026-09-25T23:00:01.000Z");
    assert.strictEqual(reauthenticated[0]?.currentProfileRef, "new-profile");
    yield* circuits.recordFailedProbe({ connectionId, now: opened.nextProbeAt, failureCount: 1 });
    const backedOff = (yield* circuits.get(connectionId))[0]!;
    assert.strictEqual(backedOff.failureCount, 2);
    assert.strictEqual(backedOff.nextProbeAt, "2026-09-25T23:00:30.000Z");
    assert.strictEqual(nextAuthProbeAt(Date.parse(now), 12), "2026-09-25T23:05:00.000Z");
    yield* circuits.close(connectionId);
    assert.lengthOf(yield* circuits.get(connectionId), 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderConnectionId, type ServerProviderUsageSnapshot } from "@penkra/contracts";
import { Deferred, Effect, Layer, Option, Stream } from "effect";
import { makeProviderUsage, ProviderUsage, ProviderUsageLive } from "./ProviderUsage.ts";
import { ProviderConnectionRepository } from "../persistence/Services/ProviderConnections.ts";
import { ProviderConnectionRepositoryLive } from "../persistence/Layers/ProviderConnections.ts";
import { ProviderInstallationRepositoryLive } from "../persistence/Layers/ProviderInstallations.ts";
import { ConnectionRateLimits, ConnectionRateLimitsLive } from "./ConnectionRateLimits.ts";
import { ServerConfig } from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../provider/Services/ProviderLaunchResolver.ts";

const id = ProviderConnectionId.makeUnsafe("account");
const snapshot = (usedPercent: number): ServerProviderUsageSnapshot => ({
  provider: "codex",
  connectionId: id,
  updatedAt: "2026-10-19T00:00:00.000Z",
  limits: [{ window: "Session", usedPercent }],
  usageLines: [],
  source: "test",
});

const migratedSql = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
const live = ProviderUsageLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProviderConnectionRepositoryLive,
      ProviderInstallationRepositoryLive,
      ConnectionRateLimitsLive,
      Layer.succeed(ProviderAdapterRegistry, {
        getByProvider: () => Effect.die("No active installation in this fixture"),
        listProviders: () => Effect.succeed([]),
      }),
      Layer.succeed(ProviderLaunchResolver, {
        resolve: () => Effect.die("Unexpected thread launch"),
        resolveProfile: () => Effect.die("No active installation in this fixture"),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "usage-events-" }),
    ).pipe(Layer.provideMerge(migratedSql)),
  ),
);
it.effect(
  "refreshes from committed account additions and provider quota facts, without a UI request",
  () =>
    Effect.gen(function* () {
      const connections = yield* ProviderConnectionRepository;
      const facts = yield* ConnectionRateLimits;
      const usage = yield* ProviderUsage;
      const at = "2026-10-19T00:00:00.000Z";
      yield* connections.create({
        id,
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "chatgpt",
        label: "Account",
        credentialRef: null,
        profileRef: "provider-profile:test",
        providerIdentityId: "account@example.test",
        createdAt: at,
      });
      const initial = Option.getOrThrow(
        yield* usage.changes.pipe(
          Stream.filter((change) => change.connectionId === id),
          Stream.runHead,
        ),
      );
      assert.deepStrictEqual(initial.snapshot.limits, []);
      yield* facts.update({
        connectionId: id,
        provider: "codex",
        limitsJson: JSON.stringify({ primary: { usedPercent: 30, windowDurationMins: 300 } }),
        status: null,
        sourceEventId: "quota",
        updatedAt: at,
      });
      const update = yield* usage.changes.pipe(
        Stream.filter((change) => change.snapshot.limits.some((limit) => limit.usedPercent === 30)),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(update));
    }).pipe(Effect.provide(live), Effect.provide(NodeServices.layer)),
);

it.effect("replays shared snapshots without fetching on subscription, then pushes updates", () =>
  Effect.gen(function* () {
    let loads = 0;
    const usage = yield* makeProviderUsage(() => Effect.sync(() => snapshot(++loads)));
    yield* usage.refresh(id);
    const first = Option.getOrThrow(yield* Stream.runHead(usage.changes));
    const second = Option.getOrThrow(yield* Stream.runHead(usage.changes));
    assert.deepStrictEqual(first, second);
    assert.strictEqual(loads, 1);
    let seen = 0;
    const updates = yield* usage.changes.pipe(
      Stream.tap(() => (++seen === 1 ? usage.refresh(id) : Effect.void)),
      Stream.take(2),
      Stream.runCollect,
    );
    assert.deepStrictEqual(
      Array.from(updates).map((change) => change.snapshot.limits[0]?.usedPercent),
      [1, 2],
    );
    assert.strictEqual(loads, 2);
  }).pipe(Effect.scoped),
);

it.effect("applies native usage pushes without issuing another request", () =>
  Effect.gen(function* () {
    let loads = 0;
    const usage = yield* makeProviderUsage(() =>
      Effect.sync(() => {
        loads++;
        return snapshot(10);
      }),
    );
    yield* usage.refresh(id);
    yield* Stream.runHead(usage.changes);
    yield* usage.observe(id, snapshot(70));
    const pushed = Option.getOrThrow(yield* Stream.runHead(usage.changes));
    assert.strictEqual(pushed.snapshot.limits[0]?.usedPercent, 70);
    assert.strictEqual(loads, 1);
  }).pipe(Effect.scoped),
);

it.effect("coalesces requests and observes a change arriving during a fetch", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let loads = 0;
    let active = 0;
    let maxActive = 0;
    const usage = yield* makeProviderUsage(() =>
      Effect.gen(function* () {
        loads++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (loads === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }
        active--;
        return snapshot(loads);
      }),
    );
    yield* usage.refresh(id);
    yield* Deferred.await(started);
    yield* usage.refresh(id);
    yield* usage.refresh(id);
    yield* Deferred.succeed(release, undefined);
    const latest = yield* usage.changes.pipe(
      Stream.filter((change) => change.snapshot.limits[0]?.usedPercent === 2),
      Stream.runHead,
    );
    assert.isTrue(Option.isSome(latest));
    assert.strictEqual(loads, 2);
    assert.strictEqual(maxActive, 1);
  }).pipe(Effect.scoped),
);

// One server-owned usage snapshot per Connection. Reads and subscribers never fetch.
import type { ProviderConnectionId, ServerProviderUsageSnapshot } from "@penkra/contracts";
import { Effect, Layer, ServiceMap, Stream } from "effect";
import { makeInvalidationHub } from "../cleanCore/invalidationHub.ts";
import { ProviderConnectionRepository } from "../persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../persistence/Services/ProviderInstallations.ts";
import { ConnectionRateLimits } from "./ConnectionRateLimits.ts";
import { listProviderUsage } from "./index.ts";
import { ServerConfig } from "../config.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderLaunchResolver } from "../provider/Services/ProviderLaunchResolver.ts";
import {
  mergeConnectionUsageSnapshots,
  snapshotFromConnectionRateLimitFact,
} from "./runtimeFacts.ts";
import { Option } from "effect";

export type ProviderUsageChange = {
  readonly connectionId: ProviderConnectionId;
  readonly snapshot: ServerProviderUsageSnapshot;
};

export const makeProviderUsage = (
  load: (id: ProviderConnectionId) => Effect.Effect<ServerProviderUsageSnapshot | null, unknown>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const changes = yield* Effect.acquireRelease(
      Effect.sync(() => makeInvalidationHub<ProviderConnectionId | null>((id) => id ?? "snapshot")),
      (hub) => hub.close,
    );
    const snapshots = new Map<ProviderConnectionId, ServerProviderUsageSnapshot>();
    const inFlight = new Set<ProviderConnectionId>();
    const dirty = new Set<ProviderConnectionId>();
    const refresh = (id: ProviderConnectionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        dirty.add(id);
        if (inFlight.has(id)) return;
        inFlight.add(id);
        yield* Effect.gen(function* () {
          while (dirty.delete(id)) {
            yield* load(id).pipe(
              Effect.tap((snapshot) =>
                Effect.sync(() => {
                  if (snapshot === null) snapshots.delete(id);
                  else {
                    snapshots.set(id, snapshot);
                    changes.publish(id);
                  }
                }),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("provider usage refresh failed", { connectionId: id, cause }),
              ),
            );
          }
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              inFlight.delete(id);
              return scope.state._tag !== "Closed" && dirty.has(id) ? refresh(id) : Effect.void;
            }),
          ),
          Effect.forkIn(scope),
        );
      });
    return {
      refresh,
      observe: (id: ProviderConnectionId, snapshot: ServerProviderUsageSnapshot) =>
        Effect.sync(() => {
          snapshots.set(
            id,
            mergeConnectionUsageSnapshots({
              runtime: snapshots.get(id) ?? null,
              fetched: snapshot,
            }),
          );
          changes.publish(id);
        }),
      snapshot: Effect.sync(() => [...snapshots.values()]),
      changes: changes.stream(undefined, null).pipe(
        Stream.flatMap((id) =>
          Stream.fromIterable(
            id === null
              ? [...snapshots].map(([connectionId, snapshot]) => ({ connectionId, snapshot }))
              : snapshots.has(id)
                ? [{ connectionId: id, snapshot: snapshots.get(id)! }]
                : [],
          ),
        ),
        Stream.changesWith(
          (previous, next) =>
            previous.connectionId === next.connectionId && previous.snapshot === next.snapshot,
        ),
      ),
    };
  });

export class ProviderUsage extends ServiceMap.Service<
  ProviderUsage,
  Effect.Success<ReturnType<typeof makeProviderUsage>>
>()("penkra/providerUsage/ProviderUsage") {}

export const ProviderUsageLive = Layer.effect(
  ProviderUsage,
  Effect.gen(function* () {
    const connections = yield* ProviderConnectionRepository;
    const installations = yield* ProviderInstallationRepository;
    const facts = yield* ConnectionRateLimits;
    const scope = yield* Effect.scope;
    // Capture the loader's dependencies now; refresh fibers retain this service scope.
    const config = yield* ServerConfig;
    const registry = yield* ProviderAdapterRegistry;
    const resolver = yield* ProviderLaunchResolver;
    const usage = yield* makeProviderUsage((id) =>
      Effect.gen(function* () {
        const [snapshot] = yield* listProviderUsage({ connectionIds: [id] });
        return snapshot ?? null;
      }).pipe(
        Effect.provideService(ServerConfig, config),
        Effect.provideService(ProviderConnectionRepository, connections),
        Effect.provideService(ConnectionRateLimits, facts),
        Effect.provideService(ProviderInstallationRepository, installations),
        Effect.provideService(ProviderAdapterRegistry, registry),
        Effect.provideService(ProviderLaunchResolver, resolver),
      ),
    );
    const refreshAll = Effect.gen(function* () {
      for (const connection of yield* connections.list()) yield* usage.refresh(connection.id);
    });
    yield* connections.changes.pipe(Stream.runForEach(usage.refresh), Effect.forkIn(scope));
    yield* facts.refreshRequests.pipe(Stream.runForEach(usage.refresh), Effect.forkIn(scope));
    yield* facts.changes.pipe(
      Stream.runForEach((id) =>
        Effect.gen(function* () {
          const observed = yield* facts.get(id);
          const snapshot = Option.isSome(observed)
            ? snapshotFromConnectionRateLimitFact(observed.value)
            : null;
          if (snapshot) yield* usage.observe(id, snapshot);
        }),
      ),
      Effect.forkIn(scope),
    );
    yield* installations.changes.pipe(
      Stream.runForEach((provider) =>
        Effect.gen(function* () {
          for (const connection of yield* connections.list())
            if (connection.harness === provider) yield* usage.refresh(connection.id);
        }),
      ),
      Effect.forkIn(scope),
    );
    yield* refreshAll.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("initial provider usage refresh failed", { cause }),
      ),
      Effect.forkIn(scope),
    );
    return usage;
  }),
);

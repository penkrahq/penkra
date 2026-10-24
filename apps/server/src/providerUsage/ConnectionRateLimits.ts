// FILE: ConnectionRateLimits.ts
// Purpose: Process-local provider quota observations; never restored from SQLite.

import type { ProviderConnectionId, ProviderKind } from "@penkra/contracts";
import { Effect, Layer, Option, Context, type Stream } from "effect";
import { makeInvalidationHub } from "../cleanCore/invalidationHub.ts";

import { mergeCodexQuotaFacts } from "./codexQuotaBuckets.ts";

export interface ConnectionRateLimitObservation {
  readonly connectionId: ProviderConnectionId;
  readonly provider: ProviderKind;
  readonly limitsJson: string;
  readonly status: string | null;
  readonly sourceEventId: string;
  readonly updatedAt: string;
}

export class ConnectionRateLimits extends Context.Service<
  ConnectionRateLimits,
  {
    readonly get: (
      connectionId: ProviderConnectionId,
    ) => Effect.Effect<Option.Option<ConnectionRateLimitObservation>>;
    readonly update: (observation: ConnectionRateLimitObservation) => Effect.Effect<void, Error>;
    readonly refreshUsage: (connectionId: ProviderConnectionId) => Effect.Effect<void>;
    readonly changes: Stream.Stream<ProviderConnectionId>;
    readonly refreshRequests: Stream.Stream<ProviderConnectionId>;
  }
>()("penkra/providerUsage/ConnectionRateLimits") {}

export const makeConnectionRateLimits = Effect.sync(() => {
  const observations = new Map<ProviderConnectionId, ConnectionRateLimitObservation>();
  const changes = makeInvalidationHub<ProviderConnectionId>((id) => id);
  const refreshRequests = makeInvalidationHub<ProviderConnectionId>((id) => id);
  return {
    changes: changes.stream(),
    refreshRequests: refreshRequests.stream(),
    close: Effect.all([changes.close, refreshRequests.close], { discard: true }),
    refreshUsage: (connectionId: ProviderConnectionId) =>
      Effect.sync(() => refreshRequests.publish(connectionId)),
    get: (connectionId: ProviderConnectionId) =>
      Effect.sync(() => Option.fromUndefinedOr(observations.get(connectionId))),
    update: (observation: ConnectionRateLimitObservation) =>
      Effect.try({
        try: () => {
          const previous = observations.get(observation.connectionId);
          if (previous?.sourceEventId === observation.sourceEventId) return;
          const limitsJson =
            observation.provider === "codex"
              ? mergeCodexQuotaFacts(
                  previous?.limitsJson,
                  previous?.updatedAt,
                  observation.limitsJson,
                  observation.updatedAt,
                )
              : observation.limitsJson;
          observations.set(observation.connectionId, { ...observation, limitsJson });
          changes.publish(observation.connectionId);
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
  };
});

export const ConnectionRateLimitsLive = Layer.effect(
  ConnectionRateLimits,
  Effect.acquireRelease(makeConnectionRateLimits, (service) => service.close),
);

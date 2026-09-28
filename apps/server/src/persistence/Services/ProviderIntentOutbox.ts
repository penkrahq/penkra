import type { OrchestrationEvent } from "@penkra/contracts";
import { ServiceMap, type Effect, type Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";
import type { ProviderIntentEvent } from "../../orchestration/providerIntentClassification.ts";

export interface ProviderIntentOutboxShape {
  readonly getLegacyCutover: () => Effect.Effect<
    {
      readonly throughSequence: number;
      readonly drainedAt: string | null;
    },
    PersistenceSqlError
  >;
  readonly markLegacyDrained: (at: string) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Called inside the command's event, projection, and receipt transaction. */
  readonly enqueueInCurrentTransaction: (
    event: ProviderIntentEvent,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly readPending: (
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<ProviderIntentOutboxJob>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly listRunnableLaneHeads: (
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<ProviderIntentOutboxJob>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly claimLaneHead: (input: {
    readonly eventSequence: number;
    readonly laneKey: string;
    readonly owner: string;
    readonly now: string;
    readonly expiresAt: string;
  }) => Effect.Effect<
    Option.Option<ProviderIntentOutboxJob>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly settleClaim: (input: {
    readonly eventSequence: number;
    readonly owner: string;
    readonly generation: number;
    readonly state: "succeeded" | "retry" | "dead" | "uncertain";
    readonly at: string;
    readonly error?: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly countUnsettledThrough: (
    throughSequence: number,
  ) => Effect.Effect<number, PersistenceSqlError>;
  readonly listExpiredClaims: (
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<ProviderIntentOutboxJob>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly settleExpiredClaim: (input: {
    readonly eventSequence: number;
    readonly owner: string;
    readonly generation: number;
    readonly now: string;
    readonly state: "retry" | "uncertain";
    readonly error: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly abandonAfterFence: (input: {
    readonly eventSequence: number;
    readonly at: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
}

export interface ProviderIntentOutboxJob {
  readonly eventSequence: number;
  readonly eventId: string;
  readonly threadId: string;
  readonly laneKey: string;
  readonly bindingRevision: number | null;
  readonly lifecycleGeneration: string | null;
  readonly eventType: string;
  readonly event: OrchestrationEvent;
  readonly state:
    | "pending"
    | "inflight"
    | "retry"
    | "succeeded"
    | "dead"
    | "uncertain"
    | "abandoned";
  readonly claimGeneration: number;
  readonly claimOwner: string | null;
  readonly claimExpiresAt: string | null;
  readonly attemptCount: number;
}

export class ProviderIntentOutbox extends ServiceMap.Service<
  ProviderIntentOutbox,
  ProviderIntentOutboxShape
>()("penkra/persistence/Services/ProviderIntentOutbox/ProviderIntentOutbox") {}

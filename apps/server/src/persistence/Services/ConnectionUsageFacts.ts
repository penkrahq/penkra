// FILE: ConnectionUsageFacts.ts
// Purpose: Read provider-owned account usage facts materialized from live runtime events.

import { IsoDateTime, NonNegativeInt, ProviderConnectionId, ProviderKind } from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ConnectionUsageFactRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const ConnectionRateLimitFactRecord = Schema.Struct({
  connectionId: ProviderConnectionId,
  provider: ProviderKind,
  limitsJson: Schema.String,
  status: Schema.NullOr(Schema.String),
  sourceEventId: Schema.String,
  updatedAt: IsoDateTime,
});
export type ConnectionRateLimitFactRecord = typeof ConnectionRateLimitFactRecord.Type;

export const ConnectionDailyUsageFactRecord = Schema.Struct({
  utcDay: Schema.String,
  connectionId: ProviderConnectionId,
  provider: ProviderKind,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningOutputTokens: NonNegativeInt,
  turns: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type ConnectionDailyUsageFactRecord = typeof ConnectionDailyUsageFactRecord.Type;

export interface ConnectionUsageFactRepositoryShape {
  readonly getRateLimits: (
    connectionId: ProviderConnectionId,
  ) => Effect.Effect<
    Option.Option<ConnectionRateLimitFactRecord>,
    ConnectionUsageFactRepositoryError
  >;
  readonly putRateLimits: (
    record: ConnectionRateLimitFactRecord,
  ) => Effect.Effect<void, ConnectionUsageFactRepositoryError>;
  readonly listDailyUsage: (input: {
    readonly connectionId: ProviderConnectionId;
    readonly sinceUtcDay: string;
  }) => Effect.Effect<
    ReadonlyArray<ConnectionDailyUsageFactRecord>,
    ConnectionUsageFactRepositoryError
  >;
}

export class ConnectionUsageFactRepository extends ServiceMap.Service<
  ConnectionUsageFactRepository,
  ConnectionUsageFactRepositoryShape
>()("penkra/persistence/Services/ConnectionUsageFacts/ConnectionUsageFactRepository") {}

// FILE: ConnectionUsageFacts.ts
// Purpose: Read provider-owned account usage facts materialized from live runtime events.

import {
  IsoDateTime,
  ProviderConnectionId,
  ProviderKind,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ConnectionUsageFactRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const ConnectionRateLimitFactRecord = Schema.Struct({
  connectionId: ProviderConnectionId,
  provider: ProviderKind,
  limitsJson: Schema.String,
  status: Schema.NullOr(TrimmedNonEmptyString),
  sourceEventId: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ConnectionRateLimitFactRecord = typeof ConnectionRateLimitFactRecord.Type;

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
}

export class ConnectionUsageFactRepository extends ServiceMap.Service<
  ConnectionUsageFactRepository,
  ConnectionUsageFactRepositoryShape
>()("penkra/persistence/Services/ConnectionUsageFacts/ConnectionUsageFactRepository") {}

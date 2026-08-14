// FILE: ProviderConnections.ts
// Purpose: Durable Connection lifecycle and Space-default repository contract.

import {
  IsoDateTime,
  ProviderConnection,
  ProviderConnectionHealth,
  ProviderConnectionId,
  ProviderConnectionTerminationReason,
  ProviderKind,
  SpaceConnectionDefault,
  SpaceId,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ProviderConnectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const ProviderConnectionRecord = Schema.Struct({
  id: ProviderConnectionId,
  harness: ProviderKind,
  authenticationTargetId: TrimmedNonEmptyString,
  authenticationMethodId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  credentialRef: Schema.NullOr(TrimmedNonEmptyString),
  profileRef: Schema.NullOr(TrimmedNonEmptyString),
  providerIdentityId: Schema.NullOr(TrimmedNonEmptyString),
  health: ProviderConnectionHealth,
  healthReason: Schema.NullOr(TrimmedNonEmptyString),
  lastCheckedAt: Schema.NullOr(IsoDateTime),
  lifecycle: Schema.Literals(["active", "terminated"]),
  terminationReason: Schema.NullOr(ProviderConnectionTerminationReason),
  terminatedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderConnectionRecord = typeof ProviderConnectionRecord.Type;

export const CreateProviderConnectionInput = Schema.Struct({
  id: ProviderConnectionId,
  harness: ProviderKind,
  authenticationTargetId: TrimmedNonEmptyString,
  authenticationMethodId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  credentialRef: Schema.NullOr(TrimmedNonEmptyString),
  profileRef: Schema.NullOr(TrimmedNonEmptyString),
  providerIdentityId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type CreateProviderConnectionInput = typeof CreateProviderConnectionInput.Type;

export interface ProviderConnectionRepositoryShape {
  readonly create: (
    input: CreateProviderConnectionInput,
  ) => Effect.Effect<ProviderConnection, ProviderConnectionRepositoryError>;
  readonly getRecord: (
    id: ProviderConnectionId,
  ) => Effect.Effect<Option.Option<ProviderConnectionRecord>, ProviderConnectionRepositoryError>;
  readonly list: (input?: {
    readonly includeTerminated?: boolean;
  }) => Effect.Effect<ReadonlyArray<ProviderConnection>, ProviderConnectionRepositoryError>;
  readonly rename: (input: {
    readonly id: ProviderConnectionId;
    readonly label: string;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderConnection>, ProviderConnectionRepositoryError>;
  readonly identifyManaged: (input: {
    readonly id: ProviderConnectionId;
    readonly label: string;
    readonly providerIdentityId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderConnection>, ProviderConnectionRepositoryError>;
  readonly reactivateIdentity: (input: {
    readonly id: ProviderConnectionId;
    readonly harness: ProviderKind;
    readonly authenticationTargetId: string;
    readonly authenticationMethodId: string;
    readonly label: string;
    readonly credentialRef: string | null;
    readonly profileRef: string | null;
    readonly providerIdentityId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderConnection>, ProviderConnectionRepositoryError>;
  readonly observeHealth: (input: {
    readonly id: ProviderConnectionId;
    readonly health: ProviderConnectionHealth;
    readonly reason: string | null;
    readonly checkedAt: string;
  }) => Effect.Effect<Option.Option<ProviderConnection>, ProviderConnectionRepositoryError>;
  readonly terminate: (input: {
    readonly id: ProviderConnectionId;
    readonly reason: ProviderConnectionTerminationReason;
    readonly terminatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderConnection>, ProviderConnectionRepositoryError>;
  readonly setSpaceDefault: (
    input: SpaceConnectionDefault,
  ) => Effect.Effect<void, ProviderConnectionRepositoryError>;
  readonly listSpaceDefaults: (
    spaceId: SpaceId,
  ) => Effect.Effect<ReadonlyArray<SpaceConnectionDefault>, ProviderConnectionRepositoryError>;
}

export class ProviderConnectionRepository extends ServiceMap.Service<
  ProviderConnectionRepository,
  ProviderConnectionRepositoryShape
>()("penkra/persistence/Services/ProviderConnections/ProviderConnectionRepository") {}

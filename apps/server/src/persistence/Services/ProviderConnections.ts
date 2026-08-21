// FILE: ProviderConnections.ts
// Purpose: Durable Connection lifecycle repository contract.

import {
  IsoDateTime,
  ProviderConnection,
  ProviderConnectionHealth,
  ProviderConnectionId,
  ProviderConnectionTerminationReason,
  ProviderKind,
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

export const ProviderCredentialProfileRecord = Schema.Struct({
  profileRef: TrimmedNonEmptyString,
  harness: ProviderKind,
  authenticationTargetId: TrimmedNonEmptyString,
  authenticationMethodId: TrimmedNonEmptyString,
  lifecycle: Schema.Literals(["staging", "active", "retired", "removed"]),
  connectionId: Schema.NullOr(ProviderConnectionId),
  loginOperationId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  retiredAt: Schema.NullOr(IsoDateTime),
});
export type ProviderCredentialProfileRecord = typeof ProviderCredentialProfileRecord.Type;

export interface ManagedProfileCommitResult {
  readonly connection: ProviderConnection;
  readonly retiredProfileRef: string | null;
}

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
  readonly commitManagedProfile: (
    input: CreateProviderConnectionInput & {
      readonly providerIdentityId: string;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<Option.Option<ManagedProfileCommitResult>, ProviderConnectionRepositoryError>;
  readonly retireManagedProfile: (input: {
    readonly profileRef: string;
    readonly retiredAt: string;
  }) => Effect.Effect<void, ProviderConnectionRepositoryError>;
  readonly listManagedProfilesPendingCleanup: () => Effect.Effect<
    ReadonlyArray<ProviderCredentialProfileRecord>,
    ProviderConnectionRepositoryError
  >;
  readonly markManagedProfileRemoved: (input: {
    readonly profileRef: string;
    readonly removedAt: string;
  }) => Effect.Effect<void, ProviderConnectionRepositoryError>;
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
}

export class ProviderConnectionRepository extends ServiceMap.Service<
  ProviderConnectionRepository,
  ProviderConnectionRepositoryShape
>()("penkra/persistence/Services/ProviderConnections/ProviderConnectionRepository") {}

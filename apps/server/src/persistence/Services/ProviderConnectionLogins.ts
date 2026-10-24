// FILE: ProviderConnectionLogins.ts
// Purpose: In-process progress contract for provider-owned Connection login.

import {
  IsoDateTime,
  ProviderConnectionId,
  ProviderKind,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Effect, Option, Schema, Context, type PubSub, type Scope } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ProviderConnectionLoginState = Schema.Literals([
  "starting",
  "awaiting-user",
  "verified",
  "completed",
  "failed",
  "cancelled",
]);
export type ProviderConnectionLoginState = typeof ProviderConnectionLoginState.Type;

export const ProviderConnectionLoginRecord = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  connectionId: ProviderConnectionId,
  committedConnectionId: Schema.NullOr(ProviderConnectionId),
  harness: ProviderKind,
  authenticationTargetId: TrimmedNonEmptyString,
  authenticationMethodId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  profileRef: TrimmedNonEmptyString,
  providerLoginId: Schema.NullOr(TrimmedNonEmptyString),
  state: ProviderConnectionLoginState,
  providerIdentityId: Schema.NullOr(TrimmedNonEmptyString),
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderConnectionLoginRecord = typeof ProviderConnectionLoginRecord.Type;

type Error = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderConnectionLoginRepositoryShape {
  readonly subscribeChanges: Effect.Effect<
    PubSub.Subscription<ProviderConnectionLoginRecord>,
    never,
    Scope.Scope
  >;
  readonly begin: (record: ProviderConnectionLoginRecord) => Effect.Effect<void, Error>;
  readonly get: (
    operationId: string,
  ) => Effect.Effect<Option.Option<ProviderConnectionLoginRecord>>;
  readonly listOpen: () => Effect.Effect<ReadonlyArray<ProviderConnectionLoginRecord>>;
  readonly transition: (input: {
    readonly operationId: string;
    readonly state: ProviderConnectionLoginState;
    readonly providerLoginId: string | null;
    readonly providerIdentityId: string | null;
    readonly committedConnectionId?: ProviderConnectionId | null;
    readonly failureReason: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderConnectionLoginRecord>>;
}

export class ProviderConnectionLoginRepository extends Context.Service<
  ProviderConnectionLoginRepository,
  ProviderConnectionLoginRepositoryShape
>()("penkra/persistence/Services/ProviderConnectionLogins") {}

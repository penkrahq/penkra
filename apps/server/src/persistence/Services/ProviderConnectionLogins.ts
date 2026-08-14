// FILE: ProviderConnectionLogins.ts
// Purpose: Durable journal contract for provider-owned Connection login.

import {
  IsoDateTime,
  ProviderConnectionId,
  ProviderKind,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";

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
  readonly begin: (
    record: Omit<ProviderConnectionLoginRecord, "committedConnectionId"> & {
      readonly committedConnectionId?: ProviderConnectionId | null;
    },
  ) => Effect.Effect<void, Error>;
  readonly get: (
    operationId: string,
  ) => Effect.Effect<Option.Option<ProviderConnectionLoginRecord>, Error>;
  readonly listOpen: () => Effect.Effect<ReadonlyArray<ProviderConnectionLoginRecord>, Error>;
  readonly transition: (input: {
    readonly operationId: string;
    readonly state: ProviderConnectionLoginState;
    readonly providerLoginId: string | null;
    readonly providerIdentityId: string | null;
    readonly committedConnectionId?: ProviderConnectionId | null;
    readonly failureReason: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderConnectionLoginRecord>, Error>;
}

export class ProviderConnectionLoginRepository extends ServiceMap.Service<
  ProviderConnectionLoginRepository,
  ProviderConnectionLoginRepositoryShape
>()("penkra/persistence/Services/ProviderConnectionLogins") {}

// FILE: ProviderConnectionOperations.ts
// Purpose: Durable journal contract for cross-resource Connection lifecycle operations.

import { IsoDateTime, ProviderConnectionId, TrimmedNonEmptyString } from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ProviderConnectionOperationKind = Schema.Literals(["create-static", "terminate"]);
export type ProviderConnectionOperationKind = typeof ProviderConnectionOperationKind.Type;

export const ProviderConnectionOperationState = Schema.Literals([
  "pending",
  "credential-stored",
  "credential-removed",
  "completed",
  "failed",
]);
export type ProviderConnectionOperationState = typeof ProviderConnectionOperationState.Type;

export const ProviderConnectionOperationRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  connectionId: ProviderConnectionId,
  kind: ProviderConnectionOperationKind,
  state: ProviderConnectionOperationState,
  credentialRef: Schema.NullOr(TrimmedNonEmptyString),
  payloadJson: Schema.String,
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderConnectionOperationRecord = typeof ProviderConnectionOperationRecord.Type;

export type ProviderConnectionOperationRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface ProviderConnectionOperationRepositoryShape {
  readonly begin: (
    input: ProviderConnectionOperationRecord,
  ) => Effect.Effect<ProviderConnectionOperationRecord, ProviderConnectionOperationRepositoryError>;
  readonly get: (
    id: string,
  ) => Effect.Effect<
    Option.Option<ProviderConnectionOperationRecord>,
    ProviderConnectionOperationRepositoryError
  >;
  readonly listOpen: () => Effect.Effect<
    ReadonlyArray<ProviderConnectionOperationRecord>,
    ProviderConnectionOperationRepositoryError
  >;
  readonly transition: (input: {
    readonly id: string;
    readonly state: ProviderConnectionOperationState;
    readonly credentialRef: string | null;
    readonly failureReason: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<
    Option.Option<ProviderConnectionOperationRecord>,
    ProviderConnectionOperationRepositoryError
  >;
}

export class ProviderConnectionOperationRepository extends ServiceMap.Service<
  ProviderConnectionOperationRepository,
  ProviderConnectionOperationRepositoryShape
>()(
  "penkra/persistence/Services/ProviderConnectionOperations/ProviderConnectionOperationRepository",
) {}

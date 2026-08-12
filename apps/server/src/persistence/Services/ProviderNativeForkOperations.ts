// FILE: ProviderNativeForkOperations.ts
// Purpose: Durable exact native-fork journal contract.

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProviderNativeStateGenerationId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";
import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ProviderNativeForkOperationState = Schema.Literals([
  "pending",
  "materialized",
  "forked",
  "committed",
  "failed",
]);
export type ProviderNativeForkOperationState = typeof ProviderNativeForkOperationState.Type;

export const ProviderNativeForkOperationRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  commandId: CommandId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  state: ProviderNativeForkOperationState,
  sourceStateRevision: NonNegativeInt,
  sourceBindingRevision: NonNegativeInt,
  targetNativeStateGenerationId: ProviderNativeStateGenerationId,
  selectionJson: Schema.String,
  commandJson: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  forkResultJson: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderNativeForkOperationRecord = typeof ProviderNativeForkOperationRecord.Type;

type RepositoryError = PersistenceSqlError | PersistenceDecodeError;
export interface ProviderNativeForkOperationRepositoryShape {
  readonly begin: (
    input: ProviderNativeForkOperationRecord,
  ) => Effect.Effect<ProviderNativeForkOperationRecord, RepositoryError>;
  readonly get: (
    id: string,
  ) => Effect.Effect<Option.Option<ProviderNativeForkOperationRecord>, RepositoryError>;
  readonly listOpen: () => Effect.Effect<
    ReadonlyArray<ProviderNativeForkOperationRecord>,
    RepositoryError
  >;
  readonly transition: (input: {
    readonly id: string;
    readonly state: ProviderNativeForkOperationState;
    readonly forkResultJson?: string | null;
    readonly failureReason: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderNativeForkOperationRecord>, RepositoryError>;
  readonly markCommittedInCurrentTransaction: (input: {
    readonly id: string;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ProviderNativeForkOperationRecord>, RepositoryError>;
}

export class ProviderNativeForkOperationRepository extends ServiceMap.Service<
  ProviderNativeForkOperationRepository,
  ProviderNativeForkOperationRepositoryShape
>()("penkra/persistence/Services/ProviderNativeForkOperations/Repository") {}

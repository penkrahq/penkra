// FILE: ProviderThreadSwitchOperations.ts
// Purpose: Durable journal contract for send-time Connection switches.

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

export const ProviderThreadSwitchOperationState = Schema.Literals([
  "pending",
  "interrupted",
  "verified",
  "committed",
  "failed",
]);
export type ProviderThreadSwitchOperationState = typeof ProviderThreadSwitchOperationState.Type;

export const ProviderThreadSwitchOperationKind = Schema.Literals([
  "native-state",
  "runtime-binding",
]);
export type ProviderThreadSwitchOperationKind = typeof ProviderThreadSwitchOperationKind.Type;

export const ProviderThreadSwitchOperationRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  commandId: CommandId,
  kind: ProviderThreadSwitchOperationKind,
  state: ProviderThreadSwitchOperationState,
  sourceStateRevision: NonNegativeInt,
  sourceBindingRevision: NonNegativeInt,
  targetNativeStateGenerationId: Schema.NullOr(ProviderNativeStateGenerationId),
  selectionJson: Schema.String,
  commandJson: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  verificationJson: Schema.NullOr(Schema.String),
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderThreadSwitchOperationRecord = typeof ProviderThreadSwitchOperationRecord.Type;

export type ProviderThreadSwitchOperationRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface ProviderThreadSwitchOperationRepositoryShape {
  readonly begin: (
    input: ProviderThreadSwitchOperationRecord,
  ) => Effect.Effect<
    ProviderThreadSwitchOperationRecord,
    ProviderThreadSwitchOperationRepositoryError
  >;
  readonly get: (
    id: string,
  ) => Effect.Effect<
    Option.Option<ProviderThreadSwitchOperationRecord>,
    ProviderThreadSwitchOperationRepositoryError
  >;
  readonly listOpen: () => Effect.Effect<
    ReadonlyArray<ProviderThreadSwitchOperationRecord>,
    ProviderThreadSwitchOperationRepositoryError
  >;
  readonly transition: (input: {
    readonly id: string;
    readonly state: ProviderThreadSwitchOperationState;
    readonly failureReason: string | null;
    readonly verificationJson?: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<
    Option.Option<ProviderThreadSwitchOperationRecord>,
    ProviderThreadSwitchOperationRepositoryError
  >;
  /**
   * Atomically records the exact source observed after the blocking turn has
   * settled. The requested command remains immutable; only a pending journal
   * may adopt this settled source while moving to interrupted.
   */
  readonly markInterruptedWithSettledSelection: (input: {
    readonly id: string;
    readonly sourceStateRevision: number;
    readonly sourceBindingRevision: number;
    readonly selectionJson: string;
    readonly updatedAt: string;
  }) => Effect.Effect<
    Option.Option<ProviderThreadSwitchOperationRecord>,
    ProviderThreadSwitchOperationRepositoryError
  >;
  /** Marks the operation committed inside the caller's existing SQL transaction. */
  readonly markCommittedInCurrentTransaction: (input: {
    readonly id: string;
    readonly updatedAt: string;
  }) => Effect.Effect<
    Option.Option<ProviderThreadSwitchOperationRecord>,
    ProviderThreadSwitchOperationRepositoryError
  >;
}

export class ProviderThreadSwitchOperationRepository extends ServiceMap.Service<
  ProviderThreadSwitchOperationRepository,
  ProviderThreadSwitchOperationRepositoryShape
>()("penkra/persistence/Services/ProviderThreadSwitchOperations/Repository") {}

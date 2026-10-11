// FILE: ThreadProviderBindings.ts
// Purpose: Exact native-state and revisioned runtime-binding persistence contract.

import {
  IsoDateTime,
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderKind,
  ProviderNativeStateGenerationId,
  ThreadHarnessState,
  ThreadId,
  ThreadRuntimeBinding,
  TrimmedNonEmptyString,
} from "@penkra/contracts";
import { Effect, Option, Schema, ServiceMap } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ThreadProviderBindingRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const ThreadHarnessStateRecord = Schema.Struct({
  ...ThreadHarnessState.fields,
  nativeStateLocatorJson: Schema.String,
});
export type ThreadHarnessStateRecord = typeof ThreadHarnessStateRecord.Type;

export const CreateNativeStateGenerationInput = Schema.Struct({
  id: ProviderNativeStateGenerationId,
  ownerThreadId: ThreadId,
  harness: ProviderKind,
  adapterSchemaVersion: TrimmedNonEmptyString,
  stateManifestJson: Schema.String,
  createdAt: IsoDateTime,
});
export type CreateNativeStateGenerationInput = typeof CreateNativeStateGenerationInput.Type;

export interface ThreadProviderBindingRepositoryShape {
  readonly createNativeStateGeneration: (
    input: CreateNativeStateGenerationInput,
  ) => Effect.Effect<void, ThreadProviderBindingRepositoryError>;
  readonly bindThread: (input: {
    readonly threadId: ThreadId;
    readonly harness: ProviderKind;
    readonly nativeStateGenerationId: ProviderNativeStateGenerationId;
    readonly providerSessionId: string | null;
    readonly nativeStateLocatorJson: string;
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly modelId: string | null;
    readonly createdAt: string;
  }) => Effect.Effect<void, ThreadProviderBindingRepositoryError>;
  readonly initializeThread: (input: {
    readonly generation: CreateNativeStateGenerationInput;
    readonly threadId: ThreadId;
    readonly providerSessionId: string | null;
    readonly nativeStateLocatorJson: string;
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly modelId: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, ThreadProviderBindingRepositoryError>;
  /** Initialize a first provider binding inside the caller's SQL transaction. */
  readonly initializeThreadInCurrentTransaction: ThreadProviderBindingRepositoryShape["initializeThread"];
  readonly getHarnessState: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadHarnessStateRecord>, ThreadProviderBindingRepositoryError>;
  readonly getRuntimeBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ThreadRuntimeBinding>, ThreadProviderBindingRepositoryError>;
  readonly replaceNativeState: (input: {
    readonly threadId: ThreadId;
    readonly expectedRevision: number;
    readonly nativeStateGenerationId: ProviderNativeStateGenerationId;
    readonly providerSessionId: string | null;
    readonly nativeStateLocatorJson: string;
    readonly verifiedAt: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<
    Option.Option<ThreadHarnessStateRecord>,
    ThreadProviderBindingRepositoryError
  >;
  readonly updateRuntimeBinding: (input: {
    readonly threadId: ThreadId;
    readonly expectedRevision: number;
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly modelId: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<Option.Option<ThreadRuntimeBinding>, ThreadProviderBindingRepositoryError>;
  /** Apply a revision-checked runtime-binding change inside the caller's SQL transaction. */
  readonly updateRuntimeBindingInCurrentTransaction: ThreadProviderBindingRepositoryShape["updateRuntimeBinding"];
  readonly commitSwitch: (input: {
    readonly threadId: ThreadId;
    readonly expectedStateRevision: number;
    readonly expectedBindingRevision: number;
    readonly generation: CreateNativeStateGenerationInput;
    readonly providerSessionId: string | null;
    readonly nativeStateLocatorJson: string;
    readonly verifiedAt: string;
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly modelId: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<
    { readonly state: ThreadHarnessStateRecord; readonly binding: ThreadRuntimeBinding },
    ThreadProviderBindingRepositoryError
  >;
  /** Apply a verified switch inside the caller's existing SQL transaction. */
  readonly commitSwitchInCurrentTransaction: ThreadProviderBindingRepositoryShape["commitSwitch"];
}

export class ThreadProviderBindingRepository extends ServiceMap.Service<
  ThreadProviderBindingRepository,
  ThreadProviderBindingRepositoryShape
>()("penkra/persistence/Services/ThreadProviderBindings/ThreadProviderBindingRepository") {}

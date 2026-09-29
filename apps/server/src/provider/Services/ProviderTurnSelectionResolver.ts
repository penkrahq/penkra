// FILE: ProviderTurnSelectionResolver.ts
// Purpose: Resolve one exact, revision-checked provider selection for an existing thread.

import {
  NonNegativeInt as NonNegativeIntSchema,
  ProviderConnectionId as ProviderConnectionIdSchema,
  ProviderInstallationId as ProviderInstallationIdSchema,
  ProviderKind as ProviderKindSchema,
  ThreadId as ThreadIdSchema,
  TrimmedNonEmptyString as TrimmedNonEmptyStringSchema,
} from "@penkra/contracts";
import type {
  ModelSelection,
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderKind,
  ProviderNativeStateGenerationId,
  ThreadId,
} from "@penkra/contracts";
import { Data, Effect, Schema, ServiceMap } from "effect";

export const ResolvedProviderTurnSelection = Schema.Struct({
  threadId: ThreadIdSchema,
  harness: ProviderKindSchema,
  connectionId: Schema.NullOr(ProviderConnectionIdSchema),
  connectionLabel: Schema.NullOr(TrimmedNonEmptyStringSchema),
  previousConnectionId: Schema.NullOr(ProviderConnectionIdSchema),
  previousModelId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  previousInstallationId: Schema.NullOr(ProviderInstallationIdSchema),
  installationId: ProviderInstallationIdSchema,
  internalProviderId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  modelId: TrimmedNonEmptyStringSchema,
  modelLabel: TrimmedNonEmptyStringSchema,
  stateRevision: NonNegativeIntSchema,
  bindingRevision: NonNegativeIntSchema,
  changed: Schema.Boolean,
  requiresNativeStateMaterialization: Schema.Boolean,
  claudeAccountTransition: Schema.optional(
    Schema.Struct({
      source: Schema.Struct({
        authenticationMethodId: TrimmedNonEmptyStringSchema,
        providerIdentityId: Schema.NullOr(TrimmedNonEmptyStringSchema),
      }),
      target: Schema.Struct({
        authenticationMethodId: TrimmedNonEmptyStringSchema,
        providerIdentityId: Schema.NullOr(TrimmedNonEmptyStringSchema),
      }),
    }),
  ),
});
export type ResolvedProviderTurnSelection = typeof ResolvedProviderTurnSelection.Type;

export const ProviderTurnSelectionFailureCode = [
  "selection_failed",
  "connection_unavailable",
  "provider_mismatch",
  "connection_unauthorized",
  "model_unavailable",
  "binding_revision_required",
  "binding_revision_stale",
  "thread_binding_missing",
] as const;
export type ProviderTurnSelectionFailureCode = (typeof ProviderTurnSelectionFailureCode)[number];

type ProviderTurnSelectionResolutionErrorFields = {
  readonly code: ProviderTurnSelectionFailureCode;
  readonly detail: string;
  readonly reason?: "binding-revision-required" | "binding-revision-stale";
  readonly cause?: unknown;
};

const ProviderTurnSelectionResolutionErrorBase = Data.TaggedError(
  "ProviderTurnSelectionResolutionError",
)<ProviderTurnSelectionResolutionErrorFields>;

export class ProviderTurnSelectionResolutionError extends ProviderTurnSelectionResolutionErrorBase {
  constructor(
    input: Omit<ProviderTurnSelectionResolutionErrorFields, "code"> & {
      readonly code?: ProviderTurnSelectionFailureCode;
    },
  ) {
    super({ ...input, code: input.code ?? "selection_failed" });
  }

  override get message(): string {
    return this.detail;
  }
}

export interface ProviderTurnSelectionResolverShape {
  /** Resolve an exact selection or the host-owned default for a new thread. */
  readonly resolveNewThreadConnection: (input: {
    readonly modelSelection: ModelSelection;
    readonly connectionId?: ProviderConnectionId | null;
  }) => Effect.Effect<ProviderConnectionId | null, ProviderTurnSelectionResolutionError>;
  readonly resolveInitial: (input: {
    readonly threadId: ThreadId;
    readonly nativeStateGenerationId: ProviderNativeStateGenerationId;
    readonly modelSelection?: ModelSelection;
    /** Must be explicit; null requests an adapter-authorized anonymous route. */
    readonly connectionId?: ProviderConnectionId | null;
    readonly createdAt: string;
  }) => Effect.Effect<
    {
      readonly selection: ResolvedProviderTurnSelection;
      readonly initialization: {
        readonly generation: {
          readonly id: ProviderNativeStateGenerationId;
          readonly ownerThreadId: ThreadId;
          readonly harness: ProviderKind;
          readonly adapterSchemaVersion: string;
          readonly stateManifestJson: string;
          readonly createdAt: string;
        };
        readonly threadId: ThreadId;
        readonly providerSessionId: null;
        readonly nativeStateLocatorJson: string;
        readonly connectionId: ProviderConnectionId | null;
        readonly installationId: ProviderInstallationId;
        readonly internalProviderId: string | null;
        readonly modelId: string;
        readonly createdAt: string;
      };
    },
    ProviderTurnSelectionResolutionError
  >;
  readonly resolveExisting: (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    /** Undefined keeps the current Connection; null explicitly selects an anonymous route. */
    readonly connectionId?: ProviderConnectionId | null;
    readonly bindingRevision?: number;
  }) => Effect.Effect<ResolvedProviderTurnSelection, ProviderTurnSelectionResolutionError>;
}

export class ProviderTurnSelectionResolver extends ServiceMap.Service<
  ProviderTurnSelectionResolver,
  ProviderTurnSelectionResolverShape
>()("penkra/provider/Services/ProviderTurnSelectionResolver") {}

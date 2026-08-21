// FILE: providerConnections.ts
// Purpose: Public, secret-free contracts for managed provider Connections and thread bindings.

import { Schema } from "effect";

import {
  IsoDateTime,
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";

export const ProviderConnectionHealth = Schema.Literals(["unknown", "ready", "unavailable"]);
export type ProviderConnectionHealth = typeof ProviderConnectionHealth.Type;

export const ProviderConnectionTerminationReason = Schema.Literals([
  "signed-out",
  "disconnected",
  "removed",
  "credential-rejected",
  "expired",
]);
export type ProviderConnectionTerminationReason = typeof ProviderConnectionTerminationReason.Type;

const ProviderConnectionBase = {
  id: ProviderConnectionId,
  harness: ProviderKind,
  authenticationTargetId: TrimmedNonEmptyString,
  authenticationMethodId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  providerIdentityId: Schema.NullOr(TrimmedNonEmptyString),
  health: ProviderConnectionHealth,
  healthReason: Schema.NullOr(TrimmedNonEmptyString),
  lastCheckedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

export const ProviderConnection = Schema.Struct({
  ...ProviderConnectionBase,
  lifecycle: Schema.Literals(["active", "terminated"]),
  terminatedAt: Schema.NullOr(IsoDateTime),
  terminationReason: Schema.NullOr(ProviderConnectionTerminationReason),
});
export type ProviderConnection = typeof ProviderConnection.Type;

export const ProviderInstallationLifecycle = Schema.Literals([
  "staged",
  "active",
  "retired",
  "rejected",
]);
export type ProviderInstallationLifecycle = typeof ProviderInstallationLifecycle.Type;

export const ProviderInstallation = Schema.Struct({
  id: ProviderInstallationId,
  harness: ProviderKind,
  version: TrimmedNonEmptyString,
  platform: TrimmedNonEmptyString,
  architecture: TrimmedNonEmptyString,
  adapterVersion: TrimmedNonEmptyString,
  protocolVersion: TrimmedNonEmptyString,
  lifecycle: ProviderInstallationLifecycle,
  healthReason: Schema.NullOr(TrimmedNonEmptyString),
  installedAt: IsoDateTime,
  activatedAt: Schema.NullOr(IsoDateTime),
  retiredAt: Schema.NullOr(IsoDateTime),
});
export type ProviderInstallation = typeof ProviderInstallation.Type;

export const ThreadRuntimeBinding = Schema.Struct({
  threadId: ThreadId,
  connectionId: Schema.NullOr(ProviderConnectionId),
  installationId: ProviderInstallationId,
  internalProviderId: Schema.NullOr(TrimmedNonEmptyString),
  modelId: Schema.NullOr(TrimmedNonEmptyString),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadRuntimeBinding = typeof ThreadRuntimeBinding.Type;

export const ThreadHarnessState = Schema.Struct({
  threadId: ThreadId,
  harness: ProviderKind,
  nativeStateGenerationId: ProviderNativeStateGenerationId,
  providerSessionId: Schema.NullOr(TrimmedNonEmptyString),
  lastVerifiedResumeAt: Schema.NullOr(IsoDateTime),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadHarnessState = typeof ThreadHarnessState.Type;

export const ProviderConnectionsSnapshotInput = Schema.Struct({
  includeTerminated: Schema.optional(Schema.Boolean),
});
export type ProviderConnectionsSnapshotInput = typeof ProviderConnectionsSnapshotInput.Type;

export const ProviderConnectionsSnapshot = Schema.Struct({
  connections: Schema.Array(ProviderConnection),
  installations: Schema.Array(ProviderInstallation),
  anonymousRoutes: Schema.Array(
    Schema.Struct({ harness: ProviderKind, internalProviderId: TrimmedNonEmptyString }),
  ),
  authenticationMethods: Schema.Array(
    Schema.Union([
      Schema.Struct({
        harness: ProviderKind,
        authenticationTargetId: TrimmedNonEmptyString,
        authenticationMethodId: TrimmedNonEmptyString,
        kind: Schema.Literal("static-secret"),
        label: TrimmedNonEmptyString,
        secretPlaceholder: TrimmedNonEmptyString,
        internalProviderIds: Schema.Array(Schema.NullOr(TrimmedNonEmptyString)),
      }),
      Schema.Struct({
        harness: ProviderKind,
        authenticationTargetId: TrimmedNonEmptyString,
        authenticationMethodId: TrimmedNonEmptyString,
        kind: Schema.Literal("managed-login"),
        label: TrimmedNonEmptyString,
        internalProviderIds: Schema.Array(Schema.NullOr(TrimmedNonEmptyString)),
      }),
      Schema.Struct({
        harness: ProviderKind,
        authenticationTargetId: TrimmedNonEmptyString,
        authenticationMethodId: TrimmedNonEmptyString,
        kind: Schema.Literal("managed-secret"),
        label: TrimmedNonEmptyString,
        secretPlaceholder: TrimmedNonEmptyString,
        internalProviderIds: Schema.Array(Schema.NullOr(TrimmedNonEmptyString)),
      }),
    ]),
  ),
});
export type ProviderConnectionsSnapshot = typeof ProviderConnectionsSnapshot.Type;

export const ThreadProviderBindingSnapshotInput = Schema.Struct({ threadId: ThreadId });
export type ThreadProviderBindingSnapshotInput = typeof ThreadProviderBindingSnapshotInput.Type;
export const ThreadProviderBindingSnapshot = Schema.Struct({
  state: Schema.NullOr(ThreadHarnessState),
  binding: Schema.NullOr(ThreadRuntimeBinding),
});
export type ThreadProviderBindingSnapshot = typeof ThreadProviderBindingSnapshot.Type;

export const CreateStaticProviderConnectionInput = Schema.Struct({
  harness: ProviderKind,
  authenticationTargetId: TrimmedNonEmptyString,
  authenticationMethodId: TrimmedNonEmptyString,
  secret: Schema.String.check(Schema.isNonEmpty()),
});
export type CreateStaticProviderConnectionInput = typeof CreateStaticProviderConnectionInput.Type;

export const BeginProviderConnectionLoginInput = Schema.Struct({
  harness: ProviderKind,
  authenticationTargetId: TrimmedNonEmptyString,
  authenticationMethodId: TrimmedNonEmptyString,
  secret: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
});
export type BeginProviderConnectionLoginInput = typeof BeginProviderConnectionLoginInput.Type;

export const ProviderConnectionLoginSnapshot = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  connectionId: ProviderConnectionId,
  state: Schema.Literals(["starting", "awaiting-user", "completed", "failed", "cancelled"]),
  authUrl: Schema.NullOr(TrimmedNonEmptyString),
  connection: Schema.NullOr(ProviderConnection),
  failureReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderConnectionLoginSnapshot = typeof ProviderConnectionLoginSnapshot.Type;

export const GetProviderConnectionLoginInput = Schema.Struct({
  operationId: TrimmedNonEmptyString,
});
export type GetProviderConnectionLoginInput = typeof GetProviderConnectionLoginInput.Type;

export const TerminateProviderConnectionInput = Schema.Struct({
  connectionId: ProviderConnectionId,
  reason: ProviderConnectionTerminationReason,
});
export type TerminateProviderConnectionInput = typeof TerminateProviderConnectionInput.Type;

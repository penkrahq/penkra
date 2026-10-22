// FILE: ProviderLaunchResolver.ts
// Purpose: Resolve one exact managed installation, Connection, and native-state launch context.

import {
  ProviderConnectionId,
  ProviderInstallationId,
  ThreadId,
  ProviderKind,
} from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

export interface ProviderLaunchSpec {
  readonly assertCurrentCredentials: Effect.Effect<void, ProviderLaunchResolutionError>;
  readonly binaryPath: string;
  readonly isolationKey: string;
  readonly profileRoot: string;
  readonly nativeStateRoot: string;
  readonly connectionId: ProviderConnectionId | null;
  readonly installationId: ProviderInstallationId;
  readonly childEnvironment: (
    baseEnv: NodeJS.ProcessEnv,
    overrides?: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
}

export class ProviderLaunchResolutionError extends Data.TaggedError(
  "ProviderLaunchResolutionError",
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderLaunchResolverShape {
  readonly resolveProfile: (input: {
    readonly harness: ProviderKind;
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    readonly nativeStateIdentity: string;
    /** Present for a real Claude Thread; discovery launches have no conversation. */
    readonly claudeThreadId?: ThreadId;
  }) => Effect.Effect<ProviderLaunchSpec, ProviderLaunchResolutionError>;
  readonly resolve: (input: {
    readonly threadId: ThreadId;
    readonly connectionId: ProviderConnectionId | null;
    readonly internalProviderId: string | null;
  }) => Effect.Effect<ProviderLaunchSpec, ProviderLaunchResolutionError>;
}

export class ProviderLaunchResolver extends ServiceMap.Service<
  ProviderLaunchResolver,
  ProviderLaunchResolverShape
>()("penkra/provider/Services/ProviderLaunchResolver") {}

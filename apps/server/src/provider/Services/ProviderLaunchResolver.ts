// FILE: ProviderLaunchResolver.ts
// Purpose: Resolve one exact managed installation, Connection, and native-state launch context.

import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
  ProviderKind,
} from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

export interface ProviderLaunchSpec {
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
    /** Existing thread bindings may remain pinned to a retained installation. */
    readonly allowRetiredInstallation?: boolean;
  }) => Effect.Effect<ProviderLaunchSpec, ProviderLaunchResolutionError>;
  readonly resolve: (input: {
    readonly threadId: ThreadId;
    readonly connectionId: ProviderConnectionId | null;
    readonly installationId: ProviderInstallationId;
    readonly internalProviderId: string | null;
    /** New, not-yet-committed generation used by transactional switch preflight. */
    readonly nativeStateGenerationId?: ProviderNativeStateGenerationId;
  }) => Effect.Effect<ProviderLaunchSpec, ProviderLaunchResolutionError>;
}

export class ProviderLaunchResolver extends ServiceMap.Service<
  ProviderLaunchResolver,
  ProviderLaunchResolverShape
>()("penkra/provider/Services/ProviderLaunchResolver") {}

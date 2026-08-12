// FILE: ProviderConnectionLifecycle.ts
// Purpose: Coordinates durable Connection creation and termination across SQLite and the desktop vault.

import {
  ProviderConnection,
  ProviderConnectionId,
  ProviderConnectionTerminationReason,
  type CreateStaticProviderConnectionInput,
} from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

export class ProviderConnectionLifecycleError extends Data.TaggedError(
  "ProviderConnectionLifecycleError",
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderConnectionLifecycleShape {
  readonly createStatic: (
    input: CreateStaticProviderConnectionInput,
  ) => Effect.Effect<ProviderConnection, ProviderConnectionLifecycleError>;
  readonly terminate: (input: {
    readonly connectionId: ProviderConnectionId;
    readonly reason: ProviderConnectionTerminationReason;
  }) => Effect.Effect<ProviderConnection, ProviderConnectionLifecycleError>;
  readonly recover: Effect.Effect<void, ProviderConnectionLifecycleError>;
}

export class ProviderConnectionLifecycle extends ServiceMap.Service<
  ProviderConnectionLifecycle,
  ProviderConnectionLifecycleShape
>()("penkra/provider/Services/ProviderConnectionLifecycle") {}

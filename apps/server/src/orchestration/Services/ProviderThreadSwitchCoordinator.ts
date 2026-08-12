// FILE: ProviderThreadSwitchCoordinator.ts
// Purpose: Durable admission boundary for send-time Connection/model switches.

import type { OrchestrationCommand } from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal.ts";

export class ProviderThreadSwitchCoordinatorError extends Data.TaggedError(
  "ProviderThreadSwitchCoordinatorError",
)<{ readonly detail: string; readonly cause?: unknown }> {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderThreadSwitchCoordinatorShape {
  readonly dispatchTurnStart: (input: {
    readonly command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    readonly attachmentPrincipal: ManagedAttachmentPrincipal;
    readonly cwd?: string;
  }) => Effect.Effect<{ readonly sequence: number }, ProviderThreadSwitchCoordinatorError>;
  readonly recoverOpen: Effect.Effect<void, never>;
}

export class ProviderThreadSwitchCoordinator extends ServiceMap.Service<
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorShape
>()("penkra/orchestration/Services/ProviderThreadSwitchCoordinator") {}

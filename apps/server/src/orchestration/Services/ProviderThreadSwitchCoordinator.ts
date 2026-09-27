// FILE: ProviderThreadSwitchCoordinator.ts
// Purpose: Durable admission boundary for send-time Connection/model switches.

import type { OrchestrationCommand } from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal.ts";
import type { ProviderTurnSelectionFailureCode } from "../../provider/Services/ProviderTurnSelectionResolver.ts";

type ProviderThreadSwitchCoordinatorErrorFields = {
  readonly code: ProviderTurnSelectionFailureCode;
  readonly detail: string;
  readonly cause?: unknown;
};

const ProviderThreadSwitchCoordinatorErrorBase = Data.TaggedError(
  "ProviderThreadSwitchCoordinatorError",
)<ProviderThreadSwitchCoordinatorErrorFields>;

export class ProviderThreadSwitchCoordinatorError extends ProviderThreadSwitchCoordinatorErrorBase {
  constructor(
    input: Omit<ProviderThreadSwitchCoordinatorErrorFields, "code"> & {
      readonly code?: ProviderTurnSelectionFailureCode;
    },
  ) {
    super({ ...input, code: input.code ?? "selection_failed" });
  }

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
  readonly dispatchQueuedTurn: (input: {
    readonly command: Extract<OrchestrationCommand, { type: "thread.turn.dispatch-queued" }>;
    readonly attachmentPrincipal: ManagedAttachmentPrincipal;
    readonly cwd?: string;
  }) => Effect.Effect<{ readonly sequence: number }, ProviderThreadSwitchCoordinatorError>;
  readonly recoverOpen: Effect.Effect<void, never>;
}

export class ProviderThreadSwitchCoordinator extends ServiceMap.Service<
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorShape
>()("penkra/orchestration/Services/ProviderThreadSwitchCoordinator") {}

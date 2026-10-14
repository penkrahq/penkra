// FILE: ProviderThreadSwitchCoordinator.ts
// Purpose: Canonical admission boundary for send-time Connection/model switches.

import type {
  TurnId,
  ThreadId,
  MessageId,
  ChatAttachment,
  ProviderSkillReference,
  ProviderMentionReference,
  ModelSelection,
  ProviderConnectionId,
  ProviderStartOptions,
  ProviderReviewTarget,
  AssistantDeliveryMode,
  RuntimeMode,
} from "@penkra/contracts";
import { Data, Effect, ServiceMap } from "effect";

import type { ManagedAttachmentPrincipal } from "../../managedAttachmentPrincipal.ts";
import type { ProviderTurnSelectionFailureCode } from "../../provider/Services/ProviderTurnSelectionResolver.ts";

type ProviderThreadSwitchCoordinatorErrorFields = {
  readonly code: ProviderTurnSelectionFailureCode | "switch_operation_failed";
  readonly detail: string;
  readonly cause?: unknown;
};

const ProviderThreadSwitchCoordinatorErrorBase = Data.TaggedError(
  "ProviderThreadSwitchCoordinatorError",
)<ProviderThreadSwitchCoordinatorErrorFields>;

export class ProviderThreadSwitchCoordinatorError extends ProviderThreadSwitchCoordinatorErrorBase {
  constructor(
    input: Omit<ProviderThreadSwitchCoordinatorErrorFields, "code"> & {
      readonly code?: ProviderThreadSwitchCoordinatorErrorFields["code"];
    },
  ) {
    super({ ...input, code: input.code ?? "selection_failed" });
  }

  override get message(): string {
    return this.detail;
  }
}

export interface TurnAdmissionCommand {
  readonly threadId: ThreadId;
  readonly message: {
    readonly messageId: MessageId;
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly skills?: ReadonlyArray<ProviderSkillReference>;
    readonly mentions?: ReadonlyArray<ProviderMentionReference>;
  };
  readonly modelSelection?: ModelSelection;
  readonly connectionId?: ProviderConnectionId | null;
  readonly providerOptions?: ProviderStartOptions;
  readonly reviewTarget?: ProviderReviewTarget;
  readonly assistantDeliveryMode?: AssistantDeliveryMode;
  readonly dispatchMode: "queue" | "steer" | "interrupt-deliver";
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
}

export interface ProviderThreadSwitchCoordinatorShape {
  readonly dispatchTurnStart: (input: {
    readonly command: TurnAdmissionCommand;
    readonly attachmentPrincipal: ManagedAttachmentPrincipal;
    readonly cwd?: string;
  }) => Effect.Effect<{ readonly turnId: TurnId | null }, ProviderThreadSwitchCoordinatorError>;
}

export class ProviderThreadSwitchCoordinator extends ServiceMap.Service<
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorShape
>()("penkra/orchestration/Services/ProviderThreadSwitchCoordinator") {}

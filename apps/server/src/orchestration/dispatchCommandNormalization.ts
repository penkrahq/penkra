import type { ClientOrchestrationCommand, OrchestrationCommand } from "@penkra/contracts";
import type { FileSystem, Path } from "effect";
import { Effect } from "effect";

import { createAttachmentId } from "../attachmentStore";

export interface DispatchCommandNormalizerResult<E> {
  readonly command: OrchestrationCommand;
  /**
   * Deferred workspace-root scaffolding decided during normalization but NOT yet executed.
   * Callers must run this only after the normalized command has been successfully accepted
   * by the orchestration decider (e.g. after `orchestrationEngine.dispatch` resolves), so a
   * rejected dispatch (for example a cross-kind workspace-root ownership conflict) never
   * mutates the filesystem.
   */
  readonly prepareWorkspaceRoot: Effect.Effect<void, E> | null;
}

export interface DispatchCommandNormalizerOptions<E> {
  readonly attachmentsDir: string;
  readonly chatWorkspaceRoot?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly canonicalizeProjectWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<string, E>;
  readonly prepareChatWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;
}

export function makeDispatchCommandNormalizer<E>(options: DispatchCommandNormalizerOptions<E>) {
  return Effect.fnUntraced(function* (input: { readonly command: ClientOrchestrationCommand }) {
    if (input.command.type !== "thread.turn.start") {
      return {
        command: input.command as OrchestrationCommand,
        prepareWorkspaceRoot: null,
      };
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type === "assistant-selection") {
            const attachmentId = createAttachmentId(turnStartCommand.threadId);
            if (!attachmentId) {
              return yield* Effect.fail(new Error("Failed to create a safe attachment id."));
            }

            return {
              type: "assistant-selection" as const,
              id: attachmentId,
              assistantMessageId: attachment.assistantMessageId,
              text: attachment.text,
            };
          }

          // Binary attachment metadata is resolved from the durable managed
          // attachment ledger by OrchestrationEngine immediately before its
          // atomic event/receipt claim. Client metadata is never authoritative.
          return attachment;
        }),
      { concurrency: 1 },
    );

    return {
      command: {
        ...turnStartCommand,
        message: {
          ...turnStartCommand.message,
          attachments: normalizedAttachments,
        },
      } satisfies OrchestrationCommand,
      prepareWorkspaceRoot: null,
    };
  });
}

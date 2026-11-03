// FILE: turnDispatch.ts
// Purpose: Dispatch an admitted turn directly to its provider and settle its recorded user cohort.
import {
  MessageId,
  RuntimeMode,
  type ModelSelection,
  type ProviderTurnStartResult,
} from "@penkra/contracts";
import { Effect, Layer, Context } from "effect";
import { randomUUID } from "node:crypto";
import { parseContextTokenCount, resolveCompactionThreshold } from "@penkra/shared/model";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderLaunchResolver } from "../provider/Services/ProviderLaunchResolver.ts";
import type { ResolvedProviderTurnSelection } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { resolveSelectedThreadRuntime } from "../provider/admittedThreadRuntime.ts";
import { resolveProviderDispatchAttachments } from "../provider/providerAttachmentPaths.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderAuthCircuits } from "../provider/providerAuthCircuit.ts";
import { ProviderCatalogService } from "../provider/Services/ProviderCatalog.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { upsertThreadItem } from "./threadStore.ts";
import { threadItemActivityData } from "./threadItemData.ts";
import { buildReconstructedTurnInput } from "./reconstructedTurnInput.ts";
import { settleMessage } from "./sendMessage.ts";
import type { ProviderThreadSwitchCoordinatorShape } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";

type AdmissionCommand = Parameters<
  ProviderThreadSwitchCoordinatorShape["dispatchTurnStart"]
>[0]["command"];
type TurnDispatchInput = {
  command: AdmissionCommand;
  selection: ResolvedProviderTurnSelection;
  modelSelection: ModelSelection;
  nativeSteer: boolean;
  cwd?: string;
};
export class TurnDispatch extends Context.Service<
  TurnDispatch,
  {
    readonly dispatch: (
      input: TurnDispatchInput,
    ) => Effect.Effect<ProviderTurnStartResult, unknown>;
  }
>()("penkra/cleanCore/TurnDispatch") {}

export const TurnDispatchLive = Layer.effect(
  TurnDispatch,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    const provider = yield* ProviderService;
    const launchResolver = yield* ProviderLaunchResolver;
    const attachments = yield* ManagedAttachmentRepository;
    const settings = yield* ServerSettingsService;
    const circuits = yield* ProviderAuthCircuits;
    const catalog = yield* ProviderCatalogService;
    const publisher = yield* ThreadPublisher;
    return {
      dispatch: (input: TurnDispatchInput) =>
        provider.withIdleStopHeld(
          input.command.threadId,
          Effect.gen(function* () {
            const command = input.command;
            const threadId = command.threadId;
            const selected = input.selection;
            if (selected.connectionId !== null) {
              const blocks = yield* circuits.get(selected.connectionId);
              if (blocks[0])
                return yield* Effect.fail(
                  new Error(
                    `${blocks[0].summary} Sign in again or retry this Connection to clear the block.`,
                  ),
                );
            }
            const configuration = yield* settings.getSettings;
            if (!configuration.providers[selected.harness].enabled)
              return yield* Effect.fail(new Error(`Provider '${selected.harness}' is disabled.`));
            const [row] = yield* sql<{
              runtimeMode: RuntimeMode;
            }>`SELECT runtime_mode AS "runtimeMode" FROM threads WHERE id=${threadId}`;
            const runtimeMode = command.runtimeMode ?? row!.runtimeMode;
            let session = (yield* provider.isRoutable(threadId))
              ? (yield* provider.listSessions()).find((session) => session.threadId === threadId)
              : undefined;
            let reconstruct = false;
            if (!input.nativeSteer) {
              if (session && session.runtimeMode !== runtimeMode) {
                yield* provider.stop({ threadId, reason: "runtime-mode-change" });
                session = undefined;
              }
              if (!session) {
                const runtime = yield* resolveSelectedThreadRuntime(
                  { threadId, provider: selected.harness },
                  selected,
                  { stateDir: config.stateDir, sql, providerLaunchResolver: launchResolver },
                );
                reconstruct = runtime.requiresReconstruction;
                yield* provider.ensure(threadId, {
                  threadId,
                  provider: selected.harness,
                  modelSelection: input.modelSelection,
                  runtimeMode,
                  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                  managedLaunch: runtime.managedLaunch,
                  ...(runtime.resumeCursor === undefined
                    ? {}
                    : { resumeCursor: runtime.resumeCursor }),
                  ...(reconstruct ? { resumePolicy: "fresh" as const } : {}),
                });
              }
            }
            if (!input.nativeSteer && !reconstruct && command.reviewTarget === undefined) {
              const [usageRow] = yield* sql<{ data: string | null }>`SELECT data FROM thread_items
                WHERE thread_id=${threadId} AND source_id='context-window:latest'`;
              let usage: { usedTokens?: number; maxTokens?: number; provider?: string } | undefined;
              try {
                usage = usageRow?.data ? JSON.parse(usageRow.data).payload : undefined;
              } catch {
                usage = undefined;
              }
              if (
                usage?.provider === selected.harness &&
                typeof usage.usedTokens === "number" &&
                usage.usedTokens > 0
              ) {
                const models = yield* catalog
                  .get({ provider: selected.harness, connectionId: selected.connectionId }, [
                    "models",
                  ])
                  .pipe(
                    Effect.catch(() => Effect.succeed({ models: [], version: 0, error: null })),
                  );
                const model = models.models?.find(
                  (item) => item.slug === input.modelSelection.model,
                );
                const maximum = Math.max(
                  usage.maxTokens ?? 0,
                  ...(model?.contextWindowOptions ?? []).map(
                    (item) => parseContextTokenCount(item.value) ?? 0,
                  ),
                );
                const options = input.modelSelection.options;
                const selectedThreshold = options?.compactionThreshold;
                const legacy =
                  options && "workingContextWindow" in options
                    ? options.workingContextWindow
                    : undefined;
                const threshold =
                  maximum > 0
                    ? resolveCompactionThreshold(maximum, selectedThreshold ?? legacy)
                    : 400_000;
                yield* Effect.logInfo("provider.compaction.threshold", {
                  threadId,
                  messageId: command.message.messageId,
                  provider: selected.harness,
                  usedTokens: usage.usedTokens,
                  threshold,
                });
                if (usage.usedTokens > threshold) {
                  yield* provider.compactThread({ threadId }).pipe(
                    Effect.catch((cause) =>
                      Effect.gen(function* () {
                        const message = `Context compaction failed: ${cause instanceof Error ? cause.message : String(cause)}. Sending the message anyway.`;
                        const now = new Date().toISOString();
                        yield* upsertThreadItem({
                          threadId,
                          sourceId: `compaction-failed:${randomUUID()}`,
                          kind: "notice",
                          status: "done",
                          text: message,
                          data: threadItemActivityData({
                            tone: "warning",
                            kind: "context_compaction",
                            summary: message,
                            payload: { message },
                          }),
                          createdAt: now,
                          updatedAt: now,
                        });
                        publisher.publish({ threadId });
                      }),
                    ),
                  );
                }
              }
            }
            const reconstructed = reconstruct
              ? yield* buildReconstructedTurnInput({
                  threadId,
                  provider: selected.harness,
                  currentMessageId: command.message.messageId,
                  currentInput: command.message.text,
                })
              : null;
            const dispatchAttachments = yield* resolveProviderDispatchAttachments({
              attachments: command.message.attachments,
              attachmentsDir: config.attachmentsDir,
              repository: attachments,
              threadId,
              messageId: command.message.messageId,
              provider: selected.harness,
              operation: "thread.turn.start",
            });
            const text = reconstructed ?? command.message.text;
            yield* Effect.logInfo("provider.delivery.wire_input", {
              threadId,
              messageId: command.message.messageId,
              provider: selected.harness,
              nativeSteer: input.nativeSteer,
              rebuiltHistory: reconstructed !== null,
              inputChars: text.length,
              attachmentCount: dispatchAttachments.length,
            });
            const request = {
              threadId,
              clientMessageId: MessageId.make(command.message.messageId),
              modelSelection: input.modelSelection,
              ...(text ? { input: text } : {}),
              ...(dispatchAttachments.length ? { attachments: dispatchAttachments } : {}),
              ...(command.message.skills === undefined ? {} : { skills: command.message.skills }),
              ...(command.message.mentions === undefined
                ? {}
                : { mentions: command.message.mentions }),
            };
            const result = yield* input.nativeSteer
              ? provider.steerTurn(request)
              : command.reviewTarget === undefined
                ? provider.sendTurn(request)
                : provider.startReview({ threadId, target: command.reviewTarget });
            yield* settleMessage(
              publisher,
              {
                type: "acknowledged",
                threadId,
                messageId: command.message.messageId,
                turnId: result.turnId,
              },
              new Date().toISOString(),
            );
            return result;
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        ),
    };
  }),
);

import {
  CommandId,
  FolderId,
  EventId,
  SpaceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type PenkraCreateThreadInput,
  type PenkraCreateThreadResult,
  type ProviderKind,
} from "@penkra/contracts";
import { buildPromptThreadTitleFallback } from "@penkra/shared/chatThreads";
import { Effect, Option, Schema } from "effect";

import type { ManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderThreadSwitchCoordinatorShape } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderTurnSelectionResolverShape } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { gatewayIsoNow, makeAgentCreationIds, stableGatewayDigest } from "./creationUtils.ts";
import { mcpToolResultJson } from "./protocol.ts";
import {
  AgentGatewayTargetError,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { GatewayToolError, gatewayToolErrorResult } from "./toolRuntime.ts";

interface CreationCoordinatorDependencies {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly providerTurnSelectionResolver: ProviderTurnSelectionResolverShape;
  readonly providerThreadSwitchCoordinator: ProviderThreadSwitchCoordinatorShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
}

export interface GatewayCreationContext {
  readonly kind: "provider-session";
  readonly callerThreadId: string;
  readonly callerTurnId: string | null;
  readonly assertAuthority: () => Effect.Effect<void, GatewayToolError>;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
}

/** Request ids select deterministic orchestration ids; separate calls are independent. */
export const makeCreateThreadHandler = Effect.fn(function* (
  dependencies: CreationCoordinatorDependencies,
) {
  const {
    snapshotQuery,
    orchestrationEngine,
    providerDiscovery,
    providerTurnSelectionResolver,
    providerThreadSwitchCoordinator,
    loadProviderAvailabilities,
    requireThreadShell,
  } = dependencies;

  return (input: PenkraCreateThreadInput, context: GatewayCreationContext) =>
    Effect.gen(function* () {
      if (context.callerTurnId === null) {
        return yield* Effect.fail(
          new GatewayToolError(
            "caller_turn_inactive",
            "Thread creation requires an active caller turn.",
          ),
        );
      }
      const callerTurnId = context.callerTurnId;
      const caller = yield* requireThreadShell(context.callerThreadId);
      const callerFolder = yield* snapshotQuery.getFolderShellById(caller.folderId).pipe(
        Effect.mapError((error) => new ToolInputError(errorText(error))),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new ToolInputError(`Folder "${caller.folderId}" was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
      const callerSpaceId = SpaceId.makeUnsafe(callerFolder.spaceId);

      const operationId = `gateway:create:${stableGatewayDigest({
        principalKind: context.kind,
        principalId: context.callerThreadId,
        callerTurnId,
        requestId: input.requestId,
      })}`;
      const ids = makeAgentCreationIds(operationId, 0);
      const title = input.title ?? buildPromptThreadTitleFallback(input.prompt);
      const existingThreads = [{ threadId: ids.threadId, title }];
      let dispatchAttempted = false;

      const result = yield* Effect.gen(function* () {
        const folderId = FolderId.makeUnsafe(input.folderId ?? caller.folderId);
        const folder = yield* snapshotQuery.getFolderShellById(folderId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ToolInputError(`Folder "${folderId}" was not found.`)),
              onSome: Effect.succeed,
            }),
          ),
        );
        const folderSpaceId = folder.spaceId;
        if (folderSpaceId !== callerSpaceId) {
          return yield* Effect.fail(
            new ToolInputError("Created Threads must remain in the caller Thread's Space."),
          );
        }
        if (input.runtimeMode === "full-access" && caller.runtimeMode !== "full-access") {
          return yield* Effect.fail(
            new ToolInputError(
              'Your thread runs in "approval-required" mode, so created threads cannot use "full-access".',
            ),
          );
        }
        const runtimeMode = input.runtimeMode ?? caller.runtimeMode;
        const workspaceRoot =
          (caller.folderId === folderId
            ? (caller.workingDirectory ?? folder.workspaceRoot)
            : folder.workspaceRoot) ?? process.cwd();
        const availabilities = yield* loadProviderAvailabilities;
        const target = yield* resolveAgentGatewayTarget({
          target: input.target,
          discovery: providerDiscovery,
          ...(availabilities.get(input.target.provider) !== undefined
            ? { availability: availabilities.get(input.target.provider)! }
            : {}),
          cwd: workspaceRoot,
        });
        const connectionId = yield* providerTurnSelectionResolver
          .resolveNewThreadConnection({ modelSelection: target })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

        yield* context.assertAuthority();
        dispatchAttempted = true;
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: ids.threadCreateCommandId,
          threadId: ids.threadId,
          folderId,
          title,
          modelSelection: target,
          runtimeMode,
          creationSource: "penkra_mcp",
          sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
          sourceTurnId: TurnId.makeUnsafe(callerTurnId),
          gatewayOperationId: operationId,
          gatewayOperationIndex: 0,
          createdAt: gatewayIsoNow(),
        });
        yield* context.assertAuthority();
        yield* providerThreadSwitchCoordinator.dispatchTurnStart({
          command: {
            type: "thread.turn.start",
            commandId: ids.turnStartCommandId,
            threadId: ids.threadId,
            message: {
              messageId: ids.messageId,
              role: "user",
              text: input.prompt,
              attachments: [],
            },
            modelSelection: target,
            connectionId,
            bindingRevision: 0,
            dispatchMode: "queue",
            dispatchOrigin: "agent",
            runtimeMode,
            createdAt: gatewayIsoNow(),
          },
          attachmentPrincipal: context.attachmentPrincipal,
          cwd: workspaceRoot,
        });
        yield* context.assertAuthority();

        return {
          operationId,
          requestId: input.requestId,
          threadId: ids.threadId,
          folderId,
          title,
          target,
          provider: target.provider,
          model: target.model,
          runtimeMode,
          status: "task_dispatched" as const,
        } satisfies PenkraCreateThreadResult;
      }).pipe(
        Effect.catch((error) =>
          dispatchAttempted
            ? Effect.fail(
                new GatewayToolError(
                  "operation_failed",
                  `Thread creation failed. The following thread may already exist: ${title} (${ids.threadId}). Retry this same requestId to finish it; do not restart the whole multi-call sequence.`,
                  { requestId: input.requestId, existingThreads, cause: errorText(error) },
                ),
              )
            : Effect.fail(error),
        ),
      );

      const marker = stableGatewayDigest({ operationId, kind: "thread-created-recap" });
      const createdAt = gatewayIsoNow();
      const recapPayload = Schema.decodeUnknownSync(Schema.Json)(
        JSON.parse(JSON.stringify({ source: "penkra_mcp", ...result })),
      );
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`agent:${marker}:thread-created-recap`),
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
          activity: {
            id: EventId.makeUnsafe(`gateway:${marker}:thread-created-recap`),
            tone: "info",
            kind: "penkra.threads.created",
            summary: "Created 1 Penkra thread",
            payload: recapPayload,
            turnId: TurnId.makeUnsafe(callerTurnId),
            createdAt,
          },
          createdAt,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("agent gateway could not append thread creation recap", {
              operationId,
              callerThreadId: context.callerThreadId,
              error: errorText(error),
            }),
          ),
        );
      return mcpToolResultJson(result);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          error instanceof GatewayToolError || error instanceof AgentGatewayTargetError
            ? gatewayToolErrorResult(error)
            : gatewayToolErrorResult(
                new GatewayToolError("operation_failed", errorText(error), {
                  requestId: input.requestId,
                  existingThreads: [],
                }),
              ),
        ),
      ),
    );
});

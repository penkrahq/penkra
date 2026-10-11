import { ensureDurableThreadWorkspace } from "../scratchWorkspaces.ts";
import {
  FolderId,
  MessageId,
  ThreadId,
  ModelSelection,
  RuntimeMode,
  type PenkraCreateThreadInput,
  type ProviderKind,
  PenkraCreateThreadResult,
} from "@penkra/contracts";
import { buildPromptThreadTitleFallback } from "@penkra/shared/chatThreads";
import { Effect, Option, Schema } from "effect";
import type { ManagedAttachmentPrincipal } from "../managedAttachmentPrincipal.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderTurnSelectionResolverShape } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import { ThreadLifecycle } from "../cleanCore/threadLifecycle.ts";
import { ThreadSender } from "../cleanCore/ThreadSender.ts";
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
  readonly stateDir: string;
  readonly lifecycle: typeof ThreadLifecycle.Service;
  readonly sender: typeof ThreadSender.Service;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly providerTurnSelectionResolver: ProviderTurnSelectionResolverShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly onThreadCreated?: (
    creatorThreadId: string,
    childThreadId: string,
  ) => Effect.Effect<void, unknown>;
}

export interface GatewayCreationContext {
  readonly kind: "provider-session";
  readonly callerThreadId: string;
  readonly callerTurnId: string | null;
  readonly assertAuthority: () => Effect.Effect<void, GatewayToolError>;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
}

export const makeCreateThreadHandler = (dependencies: CreationCoordinatorDependencies) =>
  Effect.succeed((input: PenkraCreateThreadInput, context: GatewayCreationContext) =>
    Effect.gen(function* () {
      yield* context.assertAuthority();
      const caller = yield* dependencies.lifecycle.get(ThreadId.makeUnsafe(context.callerThreadId));
      if (caller === null || caller.deletedAt !== null)
        return yield* Effect.fail(
          new ToolInputError(`Thread "${context.callerThreadId}" was not found.`),
        );
      const folderId = FolderId.makeUnsafe(
        input.folderId === undefined ? caller.folderId : input.folderId,
      );
      const [callerFolder, destination] = yield* Effect.all([
        dependencies.snapshotQuery.getFolderShellById(caller.folderId),
        dependencies.snapshotQuery.getFolderShellById(folderId),
      ]);
      if (Option.isNone(callerFolder) || Option.isNone(destination))
        return yield* Effect.fail(
          new ToolInputError("The caller or destination folder does not exist."),
        );
      if (callerFolder.value.spaceId !== destination.value.spaceId)
        return yield* Effect.fail(
          new ToolInputError("Created Threads must remain in the caller Thread's Space."),
        );
      const runtimeMode =
        input.runtimeMode === undefined
          ? Schema.decodeUnknownSync(RuntimeMode)(caller.runtimeMode)
          : input.runtimeMode;
      if (runtimeMode === "full-access" && caller.runtimeMode !== "full-access")
        return yield* Effect.fail(
          new ToolInputError(
            'Your thread runs in "approval-required" mode, so created threads cannot use "full-access".',
          ),
        );
      const operationId = `gateway:create:${stableGatewayDigest({ principalKind: context.kind, principalId: context.callerThreadId, requestId: input.requestId })}`;
      const ids = makeAgentCreationIds(operationId);
      const cwd =
        destination.value.workspaceRoot ??
        ensureDurableThreadWorkspace(ids.threadId, dependencies.stateDir);
      const existing = yield* dependencies.lifecycle.get(ids.threadId);
      if (existing !== null && existing.spaceId !== callerFolder.value.spaceId)
        return yield* Effect.fail(
          new ToolInputError("The created child has moved to another Space."),
        );
      if (
        existing !== null &&
        existing.runtimeMode === "full-access" &&
        caller.runtimeMode !== "full-access"
      )
        return yield* Effect.fail(
          new ToolInputError("The caller cannot drive this full-access child."),
        );
      if (
        existing !== null &&
        input.connectionId !== undefined &&
        input.connectionId !== existing.connectionId
      )
        return yield* Effect.fail(
          new ToolInputError("This request already created a thread with a different Connection."),
        );
      const requestedModel =
        existing === null
          ? input.target
          : Schema.decodeUnknownSync(ModelSelection)({
              provider: existing.provider,
              model: existing.model,
              ...(existing.modelOptions === null
                ? {}
                : { options: JSON.parse(existing.modelOptions) }),
            });
      const connectionId =
        existing === null
          ? yield* dependencies.providerTurnSelectionResolver.resolveNewThreadConnection({
              modelSelection: requestedModel,
              ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
            })
          : existing.connectionId;
      const availabilities = yield* dependencies.loadProviderAvailabilities;
      const target = yield* resolveAgentGatewayTarget({
        target: requestedModel,
        connectionId,
        discovery: dependencies.providerDiscovery,
        ...(availabilities.get(requestedModel.provider) === undefined
          ? {}
          : { availability: availabilities.get(requestedModel.provider)! }),
        cwd,
      });
      const at = gatewayIsoNow();
      const title =
        input.title === undefined ? buildPromptThreadTitleFallback(input.prompt) : input.title;
      yield* context.assertAuthority();
      const created = yield* dependencies.lifecycle.create({
        threadId: ids.threadId,
        folderId,

        title,
        modelSelection: target,
        runtimeMode:
          existing === null
            ? runtimeMode
            : Schema.decodeUnknownSync(RuntimeMode)(existing.runtimeMode),
        connection: { kind: "selected", connectionId },
        creator: { kind: "agent", threadId: ThreadId.makeUnsafe(context.callerThreadId) },
        createdAt: at,
      });
      if (created.thread.spaceId !== callerFolder.value.spaceId)
        return yield* Effect.fail(
          new ToolInputError("The created child has moved to another Space."),
        );
      if (input.connectionId !== undefined && input.connectionId !== created.thread.connectionId)
        return yield* Effect.fail(
          new ToolInputError("This request already created a thread with a different Connection."),
        );
      yield* context.assertAuthority();
      const result = yield* dependencies.sender.send({
        threadId: ids.threadId,
        dispatchMode: "queue",
        message: {
          messageId: MessageId.makeUnsafe(ids.messageId),
          text: input.prompt,
          attachments: [],
          senderThreadId: ThreadId.makeUnsafe(context.callerThreadId),
          dispatchOrigin: "agent",
          queuedAt: at,
        },
      });
      if (result.delivery === "failed") return yield* Effect.fail(new ToolInputError(result.error));
      if (result.delivery === "queued")
        return yield* Effect.fail(
          new ToolInputError("The thread's initial message is queued behind running work."),
        );
      if (created.created && dependencies.onThreadCreated !== undefined)
        yield* dependencies.onThreadCreated(context.callerThreadId, ids.threadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not inherit thread home window", {
              error: errorText(error),
            }),
          ),
        );
      return mcpToolResultJson(
        Schema.decodeUnknownSync(PenkraCreateThreadResult)({
          operationId,
          requestId: input.requestId,
          threadId: created.thread.id,
          folderId: created.thread.folderId,
          title: created.thread.title,
          target,
          provider: created.thread.provider,
          model: created.thread.model,
          runtimeMode: created.thread.runtimeMode,
          connectionId: created.thread.connectionId,
          messageId: ids.messageId,
          turnId: result.turnId,
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          gatewayToolErrorResult(
            error instanceof GatewayToolError || error instanceof AgentGatewayTargetError
              ? error
              : new GatewayToolError("THREAD_CREATE_FAILED", errorText(error)),
          ),
        ),
      ),
    ),
  );

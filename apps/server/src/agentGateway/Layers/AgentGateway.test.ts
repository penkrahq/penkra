interface TestTurnCommand {
  type: string;
  threadId: ThreadId;
  commandId: string;
  message: any;
  [key: string]: any;
}
import { makeAgentGatewaySessionRegistry } from "./AgentGatewaySessionRegistry.ts";
import { openCodeGatewayPluginSource } from "../../provider/openCodeGatewayPlugin.ts";
type OrchestrationCommand = TestTurnCommand;
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ThreadPublisherLive } from "../../cleanCore/ThreadPublisher.ts";
import { makeAgentCreationIds, stableGatewayDigest } from "../creationUtils.ts";
import { ThreadRunningError } from "../../cleanCore/threadStore.ts";
import { ThreadLifecycle } from "../../cleanCore/threadLifecycle.ts";
import { ThreadSender, type ThreadSendInput } from "../../cleanCore/ThreadSender.ts";
import { assert, describe, it } from "@effect/vitest";
import type {
  OrchestrationFolderShell,
  OrchestrationThread,
  OrchestrationThreadShell as ContractThreadShell,
  ProviderKind,
  ServerProviderStatus,
  ThreadId as ThreadIdType,
} from "@penkra/contracts";
import {
  EventId,
  MessageId,
  FolderId,
  ProviderConnectionId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";

import { Deferred, Effect, Layer, Logger, Option, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ThreadPolicyError } from "../../cleanCore/threadErrors.ts";
import { deriveAgentThreadStatus } from "../threadSummary.ts";
import { THREADS_PAGE_SIZE } from "@penkra/contracts";
import type {
  ProjectionThreadShellPageInput,
  ProjectionFolderPageCursor,
  ProjectionTranscriptSearchInput,
} from "../../cleanCore/ThreadReads.ts";
import { ThreadReads } from "../../cleanCore/ThreadReads.ts";

import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { connectionFixture } from "../../provider/defaultConnection.test-fixture.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";

import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { AgentGateway } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayLive } from "./AgentGateway.ts";
import { AgentGatewayToolBridgeLive } from "./AgentGatewayToolBridge.ts";
import { ProviderTurnSelectionResolver } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import {
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorError,
} from "../../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { CODEX_DEVELOPER_INSTRUCTIONS } from "../../codexAppServerManager.ts";
import { PENKRA_SYSTEM_PROMPT } from "../../provider/Layers/ClaudeAdapter.ts";
import {
  PENKRA_HOST_POLICY_MARKER,
  PENKRA_MCP_SERVER_INSTRUCTIONS_MARKER,
  renderPenkraMcpServerInstructions,
  takePenkraHostPolicyForSession,
} from "../harnessPolicy.ts";

const NOW = "2026-03-01T10:00:00.000Z";
const PROJECT_ID = FolderId.make("project-1");
const SPACE_ID = SpaceId.make("space-personal");
const CONNECTION_ID = ProviderConnectionId.make("connection-default");

function makeProjectShell(): OrchestrationFolderShell {
  return {
    id: PROJECT_ID,
    spaceId: SPACE_ID,
    title: "Demo project",
    workspaceRoot: "/tmp/demo",
    defaultModelSelection: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type OrchestrationThreadShell = ContractThreadShell & {
  runtimeMode: import("@penkra/contracts").RuntimeMode;
};

function makeThreadShell(
  id: string,
  overrides?: Partial<OrchestrationThreadShell>,
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    folderId: PROJECT_ID,
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    latestTurn:
      id === "thread-parent"
        ? {
            turnId: TurnId.make("turn-parent-active"),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    session:
      id === "thread-parent"
        ? {
            threadId: ThreadId.make(id),
            status: "running",
            providerName: "codex",
            activeTurnId: TurnId.make("turn-parent-active"),
            lastError: null,
            updatedAt: NOW,
          }
        : null,
    ...overrides,
  };
}

function makeThreadDetail(
  shell: OrchestrationThreadShell,
): OrchestrationThread & { runtimeMode: import("@penkra/contracts").RuntimeMode } {
  return {
    ...shell,
    deletedAt: null,
    messages: [],
    activities: [],
  };
}

interface GatewayHarness {
  readonly getThread: (id: string) => OrchestrationThreadShell | undefined;
  readonly sent: ThreadSendInput[];
  readonly dispatched: Array<OrchestrationCommand>;
  readonly setThreadDetail: (thread: OrchestrationThread) => void;
  readonly deleteThread: (threadId: string) => void;
  readonly revokeToken: (token: string) => void;
  readonly beginTurn: (
    threadId: string,
    provider: "codex" | "claudeAgent" | "opencode",
    turnId: string,
  ) => void;
  readonly endTurn: (
    threadId: string,
    provider: "codex" | "claudeAgent" | "opencode",
    turnId: string,
  ) => void;
  readonly setProjectionTurn: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly state: "queued" | "running" | "completed" | "error" | "interrupted" | "cancelled";
    readonly assistantMessageId?: string | null;
    readonly pendingMessageId?: string | null;
    readonly providerTurnId?: string | null;
    readonly providerTurnIds?: ReadonlyArray<string>;
  }) => void;
  readonly setQueuedPromotion: (
    threadId: string,
    state: "queued" | "promoting" | "cancelled",
  ) => void;
  readonly setProviderStatuses: (statuses: ReadonlyArray<ServerProviderStatus>) => void;
  readonly callTool: (input: {
    readonly token: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly originTurnId?: string;
  }) => Effect.Effect<{
    status: number;
    result: Record<string, unknown> | undefined;
  }>;
  readonly postRaw: (input: {
    readonly authorizationHeader: string | undefined;
    readonly body: unknown;
    readonly originTurnId?: string;
  }) => Effect.Effect<{ status: number; body?: unknown }>;
}

const VALID_TOKENS: Record<string, string> = {
  "token-parent": "thread-parent",
  "token-parent-claude": "thread-parent",
  "token-parent-opencode": "thread-parent",
  "token-parent-readonly": "thread-parent",
  "token-parent-second": "thread-parent",
  "token-ghost": "thread-ghost",
};

const TEST_TOOL_COMMANDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  penkra_context: ["penkra", "context"],
  penkra_list_connections: ["penkra", "connections", "list"],
  penkra_list_models: ["penkra", "models", "list"],
  penkra_list_folders: ["penkra", "folders", "list"],
  penkra_list_threads: ["penkra", "threads", "list"],
  penkra_read_thread: ["penkra", "threads", "read"],
  penkra_create_thread: ["penkra", "threads", "create"],
  penkra_send_message: ["penkra", "threads", "send"],
  penkra_steer_message: ["penkra", "threads", "steer"],
  penkra_interrupt_thread: ["penkra", "threads", "interrupt"],
  penkra_archive_thread: ["penkra", "threads", "archive"],
  penkra_unarchive_thread: ["penkra", "threads", "unarchive"],
};

function testCommandForTool(
  name: string,
  args: Record<string, unknown>,
): { command: string } | undefined {
  const command = TEST_TOOL_COMMANDS[name];
  if (!command) return undefined;
  const json = JSON.stringify(args).replaceAll("'", "\\u0027");
  return { command: `${command.join(" ")} --input '${json}'` };
}

function makeHarnessLayer(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  options: {
    readonly threadDetails?: ReadonlyMap<string, OrchestrationThread>;
    readonly resolveConnection?: (input: unknown) => void;
    readonly discoverModels?: (input: unknown) => void;
    readonly failDispatch?: (command: OrchestrationCommand) => boolean;
    readonly rejectArchivedCommands?: boolean;
    readonly rejectRunningArchive?: boolean;
    readonly sendSelectionError?: {
      readonly code:
        | "connection_unavailable"
        | "provider_mismatch"
        | "connection_unauthorized"
        | "model_unavailable"
        | "thread_binding_missing"
        | "selection_failed";
      readonly message: string;
    };
    readonly dispatchDelayMs?: number;
    readonly providerStatuses?: ReadonlyArray<ServerProviderStatus>;
    readonly pauseAfterCreate?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly advanceParentTurnAfterDispatch?: {
      readonly commandType: OrchestrationCommand["type"];
      readonly turnId: string;
      readonly state?: "running" | "completed" | "interrupted";
    };
    readonly extraFolders?: ReadonlyArray<OrchestrationFolderShell>;
    readonly endParentTurnOnSecondShellRead?: boolean;
    readonly replaceParentTurnOnFirstShellRead?: boolean;
    readonly projectParentTurnOnSecondShellRead?: {
      readonly turnId: string;
      readonly providerTurnId: string;
    };
  } = {},
) {
  const dispatched: Array<OrchestrationCommand> = [];
  const revokedTokens = new Set<string>();
  const activeTurnByScope = new Map<string, string>();
  for (const thread of threads) {
    if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
      activeTurnByScope.set(
        `${thread.id}:${thread.session.providerName}`,
        thread.session.activeTurnId,
      );
    }
  }
  const resolveSessionIdentity = (token: string) => {
    if (revokedTokens.has(token)) return null;
    const threadId = VALID_TOKENS[token];
    if (!threadId) return null;
    return {
      sessionKey: `session-for-${token}`,
      threadId: ThreadId.make(threadId),
      provider:
        token === "token-parent-claude"
          ? ("claudeAgent" as const)
          : token === "token-parent-opencode"
            ? ("opencode" as const)
            : ("codex" as const),
      issuedAt: 0,
      activeTurnId:
        activeTurnByScope.get(
          `${threadId}:${token === "token-parent-claude" ? "claudeAgent" : token === "token-parent-opencode" ? "opencode" : "codex"}`,
        ) ?? null,
      capabilities:
        token === "token-parent-readonly"
          ? new Set(["thread:read"] as const)
          : new Set(["thread:read", "thread:write"] as const),
    };
  };

  const credentialsLayer = Layer.succeed(AgentGatewayCredentials, {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    processes: makeAgentGatewaySessionRegistry().processes,
    setListeningPort: () => undefined,
    beginTurn: (threadId, provider, turnId) => {
      activeTurnByScope.set(`${threadId}:${provider}`, turnId);
    },
    endTurn: (threadId, provider, turnId) => {
      if (activeTurnByScope.get(`${threadId}:${provider}`) === turnId)
        activeTurnByScope.delete(`${threadId}:${provider}`);
    },
    endSession: (threadId, provider) => {
      activeTurnByScope.delete(`${threadId}:${provider}`);
    },
    bindWriteAuthority: (token: string) => {
      const identity = resolveSessionIdentity(token);
      if (!identity?.activeTurnId) return null;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId: identity.activeTurnId,
      };
    },
    verifyWriteAuthority: (authority) => {
      const identity = resolveSessionIdentity(authority.sessionKey.replace(/^session-for-/, ""));
      return (
        identity !== null &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider &&
        identity.activeTurnId === authority.turnId
      );
    },
    issueSessionToken: (threadId: ThreadIdType) => `token-for-${threadId}`,
    verifySessionToken: (token: string) =>
      revokedTokens.has(token) ? null : (VALID_TOKENS[token] ?? null),
    verifySession: resolveSessionIdentity,
    revokeSessionToken: (token: string) => {
      revokedTokens.add(token);
    },
    connectionForThread: (threadId: ThreadIdType) => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `token-for-${threadId}`,
    }),
    stdioProxy: { command: "node", args: ["/tmp/proxy.mjs"] },
  });

  const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));
  const summary = (
    thread: OrchestrationThreadShell,
  ): import("@penkra/contracts").CleanCoreThreadSummary => ({
    latestTurn: null,
    id: thread.id,
    spaceId: SPACE_ID,
    folderId: thread.folderId,
    title: thread.title,
    provider: thread.modelSelection.provider,
    connectionId: thread.connectionId === undefined ? null : thread.connectionId,
    model: thread.modelSelection.model,
    modelOptions:
      thread.modelSelection.options === undefined
        ? null
        : JSON.stringify(thread.modelSelection.options),
    runtimeMode: thread.runtimeMode,
    state: thread.session?.status === "running" ? "running" : "idle",
    activeTurnId:
      thread.session === null || thread.session.activeTurnId === undefined
        ? null
        : thread.session.activeTurnId,
    lastError: null,
    queue: "[]",
    saved: "[]",
    createdBy: thread.creationSource === "penkra_mcp" ? "agent" : "user",
    createdByThreadId: thread.sourceThreadId === undefined ? null : thread.sourceThreadId,
    sidebarSortOrder: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
    latestOpenQuestion: null,
    archivedAt: thread.archivedAt === undefined ? null : thread.archivedAt,
    deletedAt: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  });
  const lifecycleLayer = Layer.succeed(ThreadLifecycle, {
    archiveInactive: () => Effect.die("unused retention archive"),
    deleteExpired: () => Effect.die("unused retention delete"),
    get: (threadId) =>
      Effect.sync(() => {
        const thread = threadsById.get(threadId);
        return thread === undefined ? null : summary(thread);
      }),
    create: (input) =>
      Effect.sync(() => {
        const existing = threadsById.get(input.threadId);
        if (existing !== undefined) return { thread: summary(existing), created: false };
        const thread = makeThreadShell(input.threadId, {
          folderId: input.folderId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          connectionId:
            input.connection.kind === "selected" ? input.connection.connectionId : CONNECTION_ID,
          creationSource: input.creator.kind === "agent" ? "penkra_mcp" : null,
          sourceThreadId: input.creator.kind === "agent" ? input.creator.threadId : null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        });
        threadsById.set(input.threadId, thread);
        return { thread: summary(thread), created: true };
      }).pipe(
        Effect.flatMap((result) =>
          options.pauseAfterCreate === undefined
            ? Effect.succeed(result)
            : Deferred.succeed(options.pauseAfterCreate.entered, undefined).pipe(
                Effect.andThen(Deferred.await(options.pauseAfterCreate.release)),
                Effect.as(result),
              ),
        ),
      ),
    update: (input) =>
      Effect.suspend(() => {
        if (options.rejectRunningArchive && input.action === "archive" && input.archivedAt !== null)
          return Effect.fail(new ThreadRunningError());
        return Effect.sync(() => {
          const thread = threadsById.get(input.threadId);
          if (thread === undefined) return;
          if (input.action === "rename")
            threadsById.set(input.threadId, {
              ...thread,
              title: input.title,
              updatedAt: input.updatedAt,
            });
          else if (input.action === "archive")
            threadsById.set(input.threadId, {
              ...thread,
              archivedAt: input.archivedAt,
              updatedAt: input.updatedAt,
            });
          else threadsById.delete(input.threadId);
        });
      }),
  });

  const threadDetailsById = new Map<string, OrchestrationThread>(
    [...(options.threadDetails ?? [])].map(([id, thread]) => [
      id,
      {
        ...thread,
        messages: thread.messages.map((message) =>
          message.role === "user"
            ? { ...message, origin: message.origin ?? { _tag: "user" as const } }
            : message,
        ),
      },
    ]),
  );
  const projectionTurnsByKey = new Map<
    string,
    {
      readonly threadId: string;
      readonly turnId: string;
      readonly state: "queued" | "running" | "completed" | "error" | "interrupted" | "cancelled";
      readonly assistantMessageId: string | null;
      readonly pendingMessageId: string | null;
      readonly providerTurnId: string | null;
      readonly providerTurnIds: ReadonlyArray<string>;
    }
  >();
  const queuedPromotions: Array<{ threadId: string; state: "queued" | "promoting" | "cancelled" }> =
    [];

  let parentShellReads = 0;
  const snapshotLayer = Layer.succeed(ThreadReads, {
    queueLength: (threadId: string) =>
      Effect.succeed(
        queuedPromotions.filter(
          (promotion) => promotion.threadId === threadId && promotion.state !== "cancelled",
        ).length,
      ),
    listFolderShellPage: (after: ProjectionFolderPageCursor | null) =>
      Effect.sync(() => {
        const matching = [makeProjectShell(), ...(options.extraFolders ?? [])]
          .filter(
            (folder) =>
              after === null ||
              folder.createdAt > after.createdAt ||
              (folder.createdAt === after.createdAt && folder.id > after.folderId),
          )
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        const folders = matching.slice(0, THREADS_PAGE_SIZE).map((folder) => ({
          ...folder,
          spaceTitle: folder.spaceId === SPACE_ID ? "Personal" : null,
        }));
        const last = folders.at(-1);
        return {
          folders,
          nextCursor:
            matching.length > THREADS_PAGE_SIZE && last !== undefined
              ? { createdAt: last.createdAt, folderId: last.id }
              : null,
        };
      }),
    listThreadShellPage: (input: ProjectionThreadShellPageInput) =>
      Effect.sync(() => {
        const folders = [makeProjectShell(), ...(options.extraFolders ?? [])];
        const matching = [...threadsById.values()]
          .filter(
            (thread) =>
              folders.find((folder) => folder.id === thread.folderId)?.spaceId === input.spaceId,
          )
          .filter((thread) => input.threadIds === null || input.threadIds.includes(thread.id))
          .filter((thread) => input.folderId === null || thread.folderId === input.folderId)
          .filter(
            (thread) =>
              input.provider === null || thread.modelSelection.provider === input.provider,
          )
          .filter((thread) => input.model === null || thread.modelSelection.model === input.model)
          .filter(
            (thread) =>
              input.createdBy === null ||
              (input.createdBy === "human"
                ? thread.creationSource === null
                : thread.creationSource === input.createdBy.replace("-", "_")),
          )
          .filter((thread) => input.updatedAfter === null || thread.updatedAt >= input.updatedAfter)
          .filter(
            (thread) => input.updatedBefore === null || thread.updatedAt <= input.updatedBefore,
          )
          .filter(
            (thread) =>
              input.titleContains === null ||
              thread.title.toLowerCase().includes(input.titleContains.toLowerCase()),
          )
          .filter(
            (thread) => input.status === null || deriveAgentThreadStatus(thread) === input.status,
          )
          .filter((thread) => input.includeArchived || thread.archivedAt === null)
          .filter(
            (thread) =>
              input.after === null ||
              thread.updatedAt < input.after.updatedAt ||
              (thread.updatedAt === input.after.updatedAt && thread.id < input.after.threadId),
          )
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
        const threads = matching.slice(0, THREADS_PAGE_SIZE);
        const last = threads.at(-1);
        return {
          threads,
          nextCursor:
            matching.length > THREADS_PAGE_SIZE && last !== undefined
              ? { updatedAt: last.updatedAt, threadId: last.id }
              : null,
        };
      }),
    getThreadShellById: (threadId: ThreadIdType) =>
      Effect.sync(() => {
        if (threadId === "thread-parent") {
          parentShellReads += 1;
          if (parentShellReads === 1 && options.replaceParentTurnOnFirstShellRead) {
            activeTurnByScope.set("thread-parent:codex", "turn-parent-next");
          }
          if (parentShellReads === 2 && options.endParentTurnOnSecondShellRead) {
            activeTurnByScope.delete("thread-parent:codex");
          }
          if (parentShellReads === 2 && options.projectParentTurnOnSecondShellRead) {
            const projected = options.projectParentTurnOnSecondShellRead;
            projectionTurnsByKey.set(`thread-parent:${projected.turnId}`, {
              threadId: "thread-parent",
              turnId: projected.turnId,
              state: "running",
              assistantMessageId: null,
              pendingMessageId: null,
              providerTurnId: projected.providerTurnId,
              providerTurnIds: [projected.providerTurnId],
            });
          }
        }
        return Option.fromNullishOr(threadsById.get(threadId as string));
      }),
    getFolderShellById: (folderId: string) =>
      Effect.succeed(
        Option.fromNullishOr(
          [makeProjectShell(), ...(options.extraFolders ?? [])].find(
            (folder) => folder.id === folderId,
          ),
        ),
      ),
    getSpaceShellById: (spaceId: string) =>
      Effect.succeed(
        Option.fromNullishOr(
          spaceId === SPACE_ID
            ? {
                id: SPACE_ID,
                name: "Personal",
                icon: "home",
                sortOrder: 0,
                createdAt: NOW,
                updatedAt: NOW,
              }
            : undefined,
        ),
      ),
    getThreadDetailById: (threadId: ThreadIdType) =>
      Effect.sync(() => {
        return Option.fromNullishOr(
          threadDetailsById.get(threadId as string) ??
            Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(threadsById.get(threadId as string)),
                makeThreadDetail,
              ),
            ),
        );
      }),
    countThreadMessages: (threadId: ThreadIdType) =>
      Effect.sync(
        () =>
          (
            threadDetailsById.get(threadId as string) ??
            Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(threadsById.get(threadId as string)),
                makeThreadDetail,
              ),
            )
          )?.messages.length ?? 0,
      ),
    getThreadTurnsPage: (input: { threadId: ThreadIdType; before?: string }) =>
      Effect.sync(() => {
        const thread =
          threadDetailsById.get(input.threadId as string) ??
          Option.getOrUndefined(
            Option.map(
              Option.fromNullishOr(threadsById.get(input.threadId as string)),
              makeThreadDetail,
            ),
          );
        return {
          threadId: input.threadId,
          snapshotSequence: 1,
          conversationTurnCount:
            thread?.messages.filter((message) => message.role === "user").length ?? 0,
          messages: thread?.messages ?? [],
          userStatuses: new Map(
            (thread?.messages ?? [])
              .filter((message) => message.role === "user")
              .map((message) => [message.id, "sent"]),
          ),
          activities: thread?.activities ?? [],
          pendingInteractions: thread?.pendingInteractions ?? [],
          hasOlder: false,
          nextCursor: null,
        };
      }),
    getTurnPage: (input: { threadId: ThreadIdType; turnId: string }) =>
      Effect.sync(() => {
        const thread =
          threadDetailsById.get(input.threadId) ??
          (threadsById.has(input.threadId)
            ? makeThreadDetail(threadsById.get(input.threadId)!)
            : undefined);
        return {
          threadId: input.threadId,
          conversationTurnCount: 0,
          messages: (thread?.messages ?? []).filter((message) => message.turnId === input.turnId),
          userStatuses: new Map(),
          activities: (thread?.activities ?? []).filter(
            (activity) => activity.turnId === input.turnId,
          ),
          pendingInteractions: [],
          hasOlder: false,
          nextCursor: null,
        };
      }),
    searchThreadMessages: (input: ProjectionTranscriptSearchInput) =>
      Effect.sync(() => {
        const direction = input.order === "recent" ? -1 : 1;
        const folders = [makeProjectShell(), ...(options.extraFolders ?? [])];
        const messages = [...threadsById.values()]
          .filter(
            (thread) =>
              folders.find((folder) => folder.id === thread.folderId)?.spaceId === input.spaceId,
          )
          .filter((thread) => input.threadId === null || thread.id === input.threadId)
          .filter((thread) => input.folderId === null || thread.folderId === input.folderId)
          .filter((thread) => input.threadId !== null || thread.archivedAt === null)
          .map((thread) => thread.id)
          .flatMap((threadId) => {
            const thread =
              threadDetailsById.get(threadId as string) ??
              Option.getOrUndefined(
                Option.map(
                  Option.fromNullishOr(threadsById.get(threadId as string)),
                  makeThreadDetail,
                ),
              );
            return (thread?.messages ?? []).map((message) => ({
              threadId,
              threadTitle: thread!.title,
              threadProvider: thread!.modelSelection.provider,
              messageId: message.id,
              turnId: message.turnId ?? null,
              role: message.role,
              text: message.text,
              createdAt: message.createdAt,
            }));
          })
          .filter((message) => {
            const text = message.text.toLocaleLowerCase();
            const queryMatches = input.queries.map((query) => text.includes(query));
            return input.queryMode === "all"
              ? queryMatches.every(Boolean)
              : queryMatches.some(Boolean);
          })
          .filter((message) => !input.roles || input.roles.includes(message.role))
          .filter((message) => !input.turnId || message.turnId === input.turnId)
          .filter((message) => !input.createdAfter || message.createdAt >= input.createdAfter)
          .filter((message) => !input.createdBefore || message.createdAt < input.createdBefore)
          .toSorted(
            (left, right) =>
              direction * left.createdAt.localeCompare(right.createdAt) ||
              direction * String(left.threadId).localeCompare(String(right.threadId)) ||
              direction * String(left.messageId).localeCompare(String(right.messageId)),
          )
          .filter((message) => {
            if (!input.anchor) return true;
            const comparison =
              message.createdAt.localeCompare(input.anchor.createdAt) ||
              String(message.threadId).localeCompare(input.anchor.threadId) ||
              String(message.messageId).localeCompare(input.anchor.messageId);
            return input.order === "recent" ? comparison < 0 : comparison > 0;
          });
        return {
          messages: messages.slice(0, THREADS_PAGE_SIZE),
          hasMore: messages.length > THREADS_PAGE_SIZE,
          path: "indexed" as const,
        };
      }),
    getThreadMessageContext: (input: { threadId: ThreadIdType; messageId: string }) =>
      Effect.sync(() => {
        const thread =
          threadDetailsById.get(input.threadId as string) ??
          Option.getOrUndefined(
            Option.map(
              Option.fromNullishOr(threadsById.get(input.threadId as string)),
              makeThreadDetail,
            ),
          );
        if (!thread?.messages.some((message) => message.id === input.messageId)) {
          return Option.none();
        }
        return Option.some({
          threadId: input.threadId,
          snapshotSequence: 1,
          conversationTurnCount: thread.messages.filter((message) => message.role === "user")
            .length,
          messages: thread.messages,
          userStatuses: new Map(
            thread.messages
              .filter((message) => message.role === "user")
              .map((message) => [message.id, "sent"]),
          ),
          activities: thread.activities,
          pendingInteractions: thread.pendingInteractions,
          hasOlder: false,
          nextCursor: null,
        });
      }),
  } as unknown as (typeof ThreadReads)["Service"]);

  const nativeDispatch = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sleep(options.dispatchDelayMs ?? 0).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() => {
            if (options.rejectArchivedCommands && command.type === "thread.turn.start") {
              return Effect.fail(
                new ThreadPolicyError({
                  operation: command.type,
                  code: "thread_archived",
                  detail: "This thread is archived. Unarchive it to send messages.",
                }),
              );
            }
            dispatched.push(command);
            const advancedTurnState = options.advanceParentTurnAfterDispatch?.state ?? "running";
            if (
              options.advanceParentTurnAfterDispatch?.commandType === command.type &&
              (threadsById.get("thread-parent")?.latestTurn?.turnId !==
                options.advanceParentTurnAfterDispatch.turnId ||
                threadsById.get("thread-parent")?.latestTurn?.state !== advancedTurnState)
            ) {
              threadsById.set(
                "thread-parent",
                makeThreadShell("thread-parent", {
                  latestTurn: {
                    turnId: TurnId.make(options.advanceParentTurnAfterDispatch.turnId),
                    state: advancedTurnState,
                    requestedAt: NOW,
                    startedAt: NOW,
                    completedAt: advancedTurnState === "running" ? null : NOW,
                    assistantMessageId: null,
                  },
                  session: {
                    threadId: ThreadId.make("thread-parent"),
                    status: advancedTurnState === "running" ? "running" : "ready",
                    providerName: "codex",
                    activeTurnId:
                      advancedTurnState === "running"
                        ? TurnId.make(options.advanceParentTurnAfterDispatch.turnId)
                        : null,
                    lastError: null,
                    updatedAt: NOW,
                  },
                }),
              );
            }
            const result = options.failDispatch?.(command)
              ? Effect.fail(new Error("injected dispatch failure"))
              : Effect.succeed({ sequence: dispatched.length });
            return result;
          }),
        ),
      ),
  };
  const providerTurnSelectionResolverLayer = Layer.succeed(ProviderTurnSelectionResolver, {
    resolveNewThreadConnection: (input: unknown) => {
      options.resolveConnection?.(input);
      return Effect.succeed(CONNECTION_ID);
    },
  } as unknown as (typeof ProviderTurnSelectionResolver)["Service"]);
  const providerThreadSwitchCoordinatorLayer = Layer.effect(
    ProviderThreadSwitchCoordinator,
    Effect.gen(function* () {
      return {
        dispatchTurnStart: ({ command }: { readonly command: OrchestrationCommand }) =>
          options.sendSelectionError && command.type === "thread.turn.start"
            ? Effect.fail(
                new ProviderThreadSwitchCoordinatorError({
                  code: options.sendSelectionError.code,
                  detail: options.sendSelectionError.message,
                }),
              )
            : nativeDispatch.dispatch(command),
        recoverOpen: Effect.void,
      } as unknown as (typeof ProviderThreadSwitchCoordinator)["Service"];
    }),
  );

  const providerDiscoveryLayer = Layer.succeed(ProviderDiscoveryService, {
    listModels: (input: { provider: string }) => {
      options.discoverModels?.(input);
      const { provider } = input;
      const modelsByProvider: Record<string, ReadonlyArray<Record<string, unknown>>> = {
        codex: [
          { slug: "gpt-5.5", name: "GPT-5.5" },
          {
            slug: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            supportedReasoningEfforts: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        ],
        claudeAgent: [{ slug: "claude-sonnet-5", name: "Claude Sonnet 5" }],
        opencode: [{ slug: "openai/gpt-5", name: "OpenAI GPT-5" }],
      };
      return Effect.succeed({
        models: modelsByProvider[provider] ?? [],
        source: "test",
      });
    },
  } as unknown as (typeof ProviderDiscoveryService)["Service"]);

  const providerKinds: ReadonlyArray<ProviderKind> = ["codex", "claudeAgent", "opencode"];
  let providerStatuses =
    options.providerStatuses ??
    providerKinds.map(
      (provider): ServerProviderStatus => ({
        provider,
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW,
      }),
    );
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.sync(() => providerStatuses),
    refresh: Effect.sync(() => providerStatuses),
    streamChanges: Stream.empty,
  } as unknown as (typeof ProviderHealth)["Service"]);

  const readProjectionTurn = (threadId: string, turnId: string) => {
    const pinned = projectionTurnsByKey.get(`${threadId}:${turnId}`);
    if (pinned) {
      return {
        threadId: ThreadId.make(pinned.threadId),
        turnId: TurnId.make(pinned.turnId),
        providerTurnId: pinned.providerTurnId === null ? null : TurnId.make(pinned.providerTurnId),
        pendingMessageId:
          pinned.pendingMessageId === null ? null : MessageId.make(pinned.pendingMessageId),
        assistantMessageId:
          pinned.assistantMessageId === null ? null : MessageId.make(pinned.assistantMessageId),
        state: pinned.state,
        requestedAt: NOW,
        startedAt: pinned.state === "queued" ? null : NOW,
        completedAt:
          pinned.state === "completed" ||
          pinned.state === "error" ||
          pinned.state === "interrupted" ||
          pinned.state === "cancelled"
            ? NOW
            : null,
      };
    }
    const thread = threadsById.get(threadId);
    const turn = thread?.latestTurn;
    return turn?.turnId === turnId
      ? {
          threadId: ThreadId.make(threadId),
          turnId: TurnId.make(turnId),
          providerTurnId: turn.providerTurnId ?? null,
          pendingMessageId: null,
          assistantMessageId: turn.assistantMessageId,
          state: turn.state,
          requestedAt: turn.requestedAt,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
        }
      : undefined;
  };

  const sent: ThreadSendInput[] = [];
  const gatewayLayer = AgentGatewayLive.pipe(
    Layer.provide(NodeSqliteClient.layerMemory()),
    Layer.provide(ThreadPublisherLive),
    Layer.provide(lifecycleLayer),

    Layer.provide(AgentGatewayToolBridgeLive),
    Layer.provide(credentialsLayer),
    Layer.provide(snapshotLayer),

    Layer.provide(providerTurnSelectionResolverLayer),
    Layer.provide(providerThreadSwitchCoordinatorLayer),
    Layer.provide(providerDiscoveryLayer),
    Layer.provide(providerHealthLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderConnectionRepository, {
        list: () =>
          Effect.succeed([
            connectionFixture("codex", CONNECTION_ID),
            connectionFixture("claudeAgent", "claude-default"),
          ]),
      } as unknown as (typeof ProviderConnectionRepository)["Service"]),
    ),

    Layer.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(
          ManagedAttachmentRepository,
          {} as (typeof ManagedAttachmentRepository)["Service"],
        ),
      ),
    ),
  ).pipe(
    Layer.provide(
      Layer.succeed(ThreadSender, {
        savePrompt: () => Effect.die("Gateway cannot save operator drafts"),
        restoreSavedPrompt: () => Effect.die("Gateway cannot restore operator drafts"),
        deleteSavedPrompt: () => Effect.die("Gateway cannot delete operator drafts"),
        resumeQueuedForConnection: () => Effect.void,
        steerQueued: () => Effect.die("unused queued steer"),
        runExclusive: (_threadId, action) => action,
        getRuntime: () => Effect.succeed({ state: "idle", activeTurnId: null }),
        editQueued: () => Effect.die("Gateway does not edit composer drafts"),
        queuedThread: () => Effect.succeed(ThreadId.make("thread-cancel-queued")),
        cancelQueued: (input) => Effect.succeed({ ...input, removed: true }),
        interrupt: (threadId) =>
          Effect.succeed({
            threadId,
            interruptRequested: true,
            interruptedTurnId: TurnId.make("native-turn"),
          }),
        send: (input: ThreadSendInput) =>
          Effect.gen(function* () {
            sent.push(input);
            if (options.sendSelectionError)
              return yield* Effect.fail(new Error(options.sendSelectionError.message));
            if (options.rejectArchivedCommands)
              return yield* Effect.fail(
                new Error("This thread is archived. Unarchive it to send messages."),
              );
            return {
              threadId: input.threadId,
              messageId: input.message.messageId,
              plan: "deliver" as const,
              seq: 1,
            };
          }),
      }),
    ),
  );

  const makeHarness = Effect.gen(function* () {
    const gateway = yield* AgentGateway;
    const postRaw: GatewayHarness["postRaw"] = (input) => gateway.handleMcpPost(input);
    const callTool: GatewayHarness["callTool"] = ({ token, name, args, originTurnId }) => {
      const translatedCommand = testCommandForTool(name, args);
      return gateway
        .handleMcpPost({
          authorizationHeader: `Bearer ${token}`,
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: translatedCommand
              ? { name: "penkra_exec_command", arguments: translatedCommand }
              : { name, arguments: args },
          },
          ...(originTurnId === undefined ? {} : { originTurnId }),
        })
        .pipe(
          Effect.map((response) => ({
            status: response.status,
            result: (response.body as { result?: Record<string, unknown> } | undefined)?.result,
          })),
        );
    };
    return {
      dispatched,
      sent,
      getThread: (id) => threadsById.get(id),
      setThreadDetail: (thread) => {
        threadsById.set(thread.id, {
          ...thread,
          runtimeMode: threadsById.get(thread.id)!.runtimeMode,
        });
        threadDetailsById.set(thread.id, thread);
      },
      deleteThread: (threadId) => {
        threadsById.delete(threadId);
        threadDetailsById.delete(threadId);
      },
      revokeToken: (token) => {
        revokedTokens.add(token);
      },
      beginTurn: (threadId, provider, turnId) => {
        activeTurnByScope.set(`${threadId}:${provider}`, turnId);
      },
      endTurn: (threadId, provider, turnId) => {
        if (activeTurnByScope.get(`${threadId}:${provider}`) === turnId)
          activeTurnByScope.delete(`${threadId}:${provider}`);
      },
      setProjectionTurn: (input) => {
        projectionTurnsByKey.set(`${input.threadId}:${input.turnId}`, {
          threadId: input.threadId,
          turnId: input.turnId,
          state: input.state,
          assistantMessageId: input.assistantMessageId ?? null,
          pendingMessageId: input.pendingMessageId ?? null,
          providerTurnId: input.providerTurnId ?? null,
          providerTurnIds:
            input.providerTurnIds ??
            (input.providerTurnId === undefined || input.providerTurnId === null
              ? []
              : [input.providerTurnId]),
        });
      },
      setQueuedPromotion: (threadId, state) => {
        queuedPromotions.push({ threadId, state });
      },
      setProviderStatuses: (statuses) => {
        providerStatuses = statuses;
      },
      callTool,
      postRaw,
    } satisfies GatewayHarness;
  });

  return { gatewayLayer, makeHarness };
}

function toolResultJson(result: Record<string, unknown> | undefined): Record<string, unknown> {
  const content = (result?.content as Array<{ text: string }> | undefined) ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

function readToolResultFile(result: Record<string, unknown> | undefined): string {
  const reference = toolResultJson(result) as { resultFile: string; bytes: number };
  assert.isString(reference.resultFile);
  assert.include(reference.resultFile, "/tool-results/thread-parent/");
  const text = readFileSync(reference.resultFile, "utf8");
  assert.equal(Buffer.byteLength(text), reference.bytes);
  return text;
}

function toolResultFileJson(result: Record<string, unknown> | undefined): Record<string, unknown> {
  return JSON.parse(readToolResultFile(result)) as Record<string, unknown>;
}

function isToolError(result: Record<string, unknown> | undefined): boolean {
  return result?.isError === true;
}

function toolErrorText(result: Record<string, unknown> | undefined): string {
  const content = (result?.content as Array<{ text: string }> | undefined) ?? [];
  return content[0]?.text ?? "";
}

describe("AgentGateway", () => {
  const baseThreads = [
    makeThreadShell("thread-parent"),
    makeThreadShell("thread-child"),
    makeThreadShell("thread-archived", { archivedAt: NOW }),
  ];
  

  for (const projection of ["terminal", "missing", "running"] as const) {
    
  }

  

  

  

  

  it.effect("rejects requests without a valid bearer token", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const missing = yield* harness.postRaw({
        authorizationHeader: undefined,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(missing.status, 401);
      const invalid = yield* harness.postRaw({
        authorizationHeader: "Bearer nope",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(invalid.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  for (const replacement of ["same-native-steer", "different-execution"] as const) {
    
  }

  

  

  

  it.effect("rejects a provider-scoped token that no longer owns the thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent-claude",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  for (const [message, code] of [
    [
      "This thread uses a different provider. To use another provider, start a new thread.",
      "provider_mismatch",
    ],
    ["The selected Connection doesn't have access to this model.", "connection_unauthorized"],
    ["This model isn't available on the selected Connection.", "model_unavailable"],
    ["This thread has no provider set.", "thread_binding_missing"],
    ["Could not read the thread's runtime binding.", "selection_failed"],
  ] as const) {
    
  }

  

  

  

  

  

  

  

  

  

  

  

  
});

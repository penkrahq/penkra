import { makeAgentCreationIds, stableGatewayDigest } from "../creationUtils.ts";
import { ThreadRunningError } from "../../cleanCore/threadStore.ts";
import { ThreadLifecycle } from "../../cleanCore/threadLifecycle.ts";
import { ThreadSender, type ThreadSendInput } from "../../cleanCore/ThreadSender.ts";
import { assert, describe, it } from "@effect/vitest";
import type {
  OrchestrationCommand,
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
  ProviderInstallationId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";

import { Deferred, Effect, Layer, Logger, Option, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import { deriveAgentThreadStatus } from "../threadSummary.ts";
import { THREADS_PAGE_SIZE } from "@penkra/contracts";
import type {
  ProjectionThreadShellPageInput,
  ProjectionFolderPageCursor,
  ProjectionTranscriptSearchInput,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { QueuedTurnPromotionRepository } from "../../persistence/Services/QueuedTurnPromotions.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { connectionFixture } from "../../provider/defaultConnection.test-fixture.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderConnectionRepository } from "../../persistence/Services/ProviderConnections.ts";

import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
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
const PROJECT_ID = FolderId.makeUnsafe("project-1");
const SPACE_ID = SpaceId.makeUnsafe("space-personal");
const CONNECTION_ID = ProviderConnectionId.makeUnsafe("connection-default");

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
    id: ThreadId.makeUnsafe(id),
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
            turnId: TurnId.makeUnsafe("turn-parent-active"),
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
            threadId: ThreadId.makeUnsafe(id),
            status: "running",
            providerName: "codex",
            activeTurnId: TurnId.makeUnsafe("turn-parent-active"),
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
      threadId: ThreadId.makeUnsafe(threadId),
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
  const commandReceiptsLayer = Layer.succeed(OrchestrationCommandReceiptRepository, {
    insert: () => Effect.die("unused receipt insert"),
    getByCommandId: () => Effect.succeed(Option.none()),
  });

  const credentialsLayer = Layer.succeed(AgentGatewayCredentials, {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
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
    createdBy: thread.creationSource === "penkra_mcp" ? "agent" : "user",
    createdByThreadId: thread.sourceThreadId === undefined ? null : thread.sourceThreadId,
    sidebarSortOrder: null,
    lastActivityAt: null,
    lastMessagePreview: null,
    lastUserMessageAt: null,
    lastVisitedAt: null,
    openQuestionCount: 0,
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

  const threadDetailsById = new Map(options.threadDetails ?? []);
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
  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
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
          activities: thread?.activities ?? [],
          pendingInteractions: thread?.pendingInteractions ?? [],
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
          activities: thread.activities,
          pendingInteractions: thread.pendingInteractions,
          hasOlder: false,
          nextCursor: null,
        });
      }),
  } as unknown as (typeof ProjectionSnapshotQuery)["Service"]);

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sleep(options.dispatchDelayMs ?? 0).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() => {
            if (options.rejectArchivedCommands && command.type === "thread.turn.start") {
              return Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
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
                    turnId: TurnId.makeUnsafe(options.advanceParentTurnAfterDispatch.turnId),
                    state: advancedTurnState,
                    requestedAt: NOW,
                    startedAt: NOW,
                    completedAt: advancedTurnState === "running" ? null : NOW,
                    assistantMessageId: null,
                  },
                  session: {
                    threadId: ThreadId.makeUnsafe("thread-parent"),
                    status: advancedTurnState === "running" ? "running" : "ready",
                    providerName: "codex",
                    activeTurnId:
                      advancedTurnState === "running"
                        ? TurnId.makeUnsafe(options.advanceParentTurnAfterDispatch.turnId)
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
  } as unknown as (typeof OrchestrationEngineService)["Service"]);
  const providerTurnSelectionResolverLayer = Layer.succeed(ProviderTurnSelectionResolver, {
    resolveNewThreadConnection: (input: unknown) => {
      options.resolveConnection?.(input);
      return Effect.succeed(CONNECTION_ID);
    },
  } as unknown as (typeof ProviderTurnSelectionResolver)["Service"]);
  const providerThreadSwitchCoordinatorLayer = Layer.effect(
    ProviderThreadSwitchCoordinator,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      return {
        dispatchTurnStart: ({ command }: { readonly command: OrchestrationCommand }) =>
          options.sendSelectionError && command.type === "thread.turn.start"
            ? Effect.fail(
                new ProviderThreadSwitchCoordinatorError({
                  code: options.sendSelectionError.code,
                  detail: options.sendSelectionError.message,
                }),
              )
            : engine.dispatch(command),
        recoverOpen: Effect.void,
      } as unknown as (typeof ProviderThreadSwitchCoordinator)["Service"];
    }),
  ).pipe(Layer.provide(engineLayer));

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
        threadId: ThreadId.makeUnsafe(pinned.threadId),
        turnId: TurnId.makeUnsafe(pinned.turnId),
        providerTurnId:
          pinned.providerTurnId === null ? null : TurnId.makeUnsafe(pinned.providerTurnId),
        pendingMessageId:
          pinned.pendingMessageId === null ? null : MessageId.makeUnsafe(pinned.pendingMessageId),
        assistantMessageId:
          pinned.assistantMessageId === null
            ? null
            : MessageId.makeUnsafe(pinned.assistantMessageId),
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
          threadId: ThreadId.makeUnsafe(threadId),
          turnId: TurnId.makeUnsafe(turnId),
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
  const projectionTurnsLayer = Layer.succeed(ProjectionTurnRepository, {
    listByThreadId: ({ threadId }: { threadId: string }) =>
      Effect.sync(() => {
        const pinned = [...projectionTurnsByKey.values()]
          .filter((turn) => turn.threadId === threadId)
          .map((turn) => readProjectionTurn(turn.threadId, turn.turnId))
          .filter((turn): turn is NonNullable<typeof turn> => turn !== undefined);
        const latestTurnId = threadsById.get(threadId)?.latestTurn?.turnId;
        const latest = latestTurnId ? readProjectionTurn(threadId, latestTurnId) : undefined;
        return latest && !pinned.some((turn) => turn.turnId === latest.turnId)
          ? [...pinned, latest]
          : pinned;
      }),
    listByThreadIds: (threadIds: ReadonlyArray<string>) =>
      Effect.sync(() =>
        threadIds.flatMap((threadId) => {
          const pinned = [...projectionTurnsByKey.values()]
            .filter((turn) => turn.threadId === threadId)
            .map((turn) => readProjectionTurn(turn.threadId, turn.turnId))
            .filter((turn): turn is NonNullable<typeof turn> => turn !== undefined);
          const latestTurnId = threadsById.get(threadId)?.latestTurn?.turnId;
          const latest = latestTurnId ? readProjectionTurn(threadId, latestTurnId) : undefined;
          return latest && !pinned.some((turn) => turn.turnId === latest.turnId)
            ? [...pinned, latest]
            : pinned;
        }),
      ),
    getByTurnId: ({ threadId, turnId }: { threadId: string; turnId: string }) =>
      Effect.succeed(Option.fromNullishOr(readProjectionTurn(threadId, turnId))),
    reopenForRestart: () => Effect.void,
    listProviderTurnIds: ({ threadId, turnId }: { threadId: string; turnId: string }) =>
      Effect.succeed(
        (projectionTurnsByKey.get(`${threadId}:${turnId}`)?.providerTurnIds ?? []).map((id) =>
          TurnId.makeUnsafe(id),
        ),
      ),
    getManyByTurnId: (input: ReadonlyArray<{ threadId: string; turnId: string }>) =>
      Effect.sync(() => {
        return input.flatMap(({ threadId, turnId }) => {
          const turn = readProjectionTurn(threadId, turnId);
          return turn ? [turn] : [];
        });
      }),
    getManyWaitSnapshot: (input: {
      readonly threadIds: ReadonlyArray<string>;
      readonly turns: ReadonlyArray<{ threadId: string; turnId: string }>;
    }) =>
      Effect.sync(() => {
        return {
          existingThreadIds: input.threadIds.filter((threadId) => threadsById.has(threadId)),
          turns: input.turns.flatMap(({ threadId, turnId }) => {
            const turn = readProjectionTurn(threadId, turnId);
            return turn ? [turn] : [];
          }),
        };
      }),
  } as unknown as (typeof ProjectionTurnRepository)["Service"]);
  const queuedTurnPromotionsLayer = Layer.succeed(QueuedTurnPromotionRepository, {
    countPendingByThreadIds: (threadIds: ReadonlyArray<string>) =>
      Effect.sync(() =>
        threadIds.flatMap((threadId) => {
          const count = queuedPromotions.filter(
            (promotion) => promotion.threadId === threadId && promotion.state !== "cancelled",
          ).length;
          return count > 0 ? [{ threadId, count }] : [];
        }),
      ),
  } as unknown as (typeof QueuedTurnPromotionRepository)["Service"]);

  const sent: ThreadSendInput[] = [];
  const gatewayLayer = AgentGatewayLive.pipe(
    Layer.provide(lifecycleLayer),
    Layer.provide(commandReceiptsLayer),
    Layer.provide(AgentGatewayToolBridgeLive),
    Layer.provide(credentialsLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(engineLayer),
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
    Layer.provide(Layer.mergeAll(projectionTurnsLayer, queuedTurnPromotionsLayer)),
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
        runExclusive: (_threadId, action) => action,
        getRuntime: () => Effect.succeed({ state: "idle", activeTurnId: null }),
        editQueued: () => Effect.die("Gateway does not edit composer drafts"),
        queuedThread: () => Effect.succeed(ThreadId.makeUnsafe("thread-cancel-queued")),
        cancelQueued: (input) => Effect.succeed({ ...input, removed: true }),
        interrupt: (threadId) =>
          Effect.succeed({
            threadId,
            interruptRequested: true,
            interruptedTurnId: TurnId.makeUnsafe("native-turn"),
          }),
        send: (input: ThreadSendInput) =>
          Effect.sync(() => {
            sent.push(input);
            if (options.sendSelectionError)
              return {
                threadId: input.threadId,
                messageId: input.message.messageId,
                delivery: "failed" as const,
                error: options.sendSelectionError.message,
              };
            if (options.rejectArchivedCommands)
              return {
                threadId: input.threadId,
                messageId: input.message.messageId,
                delivery: "failed" as const,
                error: "This thread is archived. Unarchive it to send messages.",
              };
            return {
              threadId: input.threadId,
              messageId: input.message.messageId,
              delivery: "started" as const,
              turnId: TurnId.makeUnsafe("provider-confirmed-turn"),
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
    it.effect(`accepts a live provider turn with ${projection} projection evidence`, () => {
      const nativeTurnId = "claude-native-live";
      const parent = makeThreadShell("thread-parent", {
        modelSelection: { provider: "claudeAgent", model: "claude-opus" },
        latestTurn:
          projection === "missing"
            ? null
            : {
                turnId: TurnId.makeUnsafe("logical-parent"),
                providerTurnId: TurnId.makeUnsafe(nativeTurnId),
                state: projection === "terminal" ? "completed" : "running",
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: projection === "terminal" ? NOW : null,
                assistantMessageId: null,
              },
        session: {
          threadId: ThreadId.makeUnsafe("thread-parent"),
          status: "running",
          providerName: "claudeAgent",
          activeTurnId: TurnId.makeUnsafe(nativeTurnId),
          lastError: null,
          updatedAt: NOW,
        },
      });
      const { gatewayLayer, makeHarness } = makeHarnessLayer([
        parent,
        ...baseThreads.filter((thread) => thread.id !== "thread-parent"),
      ]);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.callTool({
          token: "token-parent-claude",
          name: "penkra_send_message",
          args: { threadId: "thread-child", message: "Please continue." },
        });
        assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      }).pipe(Effect.provide(gatewayLayer));
    });
  }

  it.effect("binds writes before an awaited initial thread lookup", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      replaceParentTurnOnFirstShellRead: true,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "Arrived in the old turn" },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects a late native tool request from a replaced turn", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.endTurn("thread-parent", "codex", "turn-parent-active");
      harness.beginTurn("thread-parent", "codex", "turn-parent-next");
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "Too late" },
        originTurnId: "turn-parent-active",
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("logs ingress turn evidence for an inner penkra_exec_command write refusal", () => {
    const warnings: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make(({ message }) => warnings.push(message as ReadonlyArray<unknown>));
    const threads = baseThreads.map((thread) =>
      thread.id === "thread-parent"
        ? makeThreadShell("thread-parent", {
            modelSelection: { provider: "claudeAgent", model: "claude-opus" },
            latestTurn: null,
            session: {
              threadId: thread.id,
              status: "ready",
              providerName: "claudeAgent",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          })
        : thread,
    );
    const { gatewayLayer, makeHarness } = makeHarnessLayer(threads, {});
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent-claude",
        name: "penkra_exec_command",
        args: {
          command:
            "penkra threads send --thread-id thread-child --message 'Background work finished.'",
        },
      });
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      const refusalWarnings = warnings.filter(
        (message) => message[0] === "agent_gateway.caller_turn_inactive",
      );
      assert.equal(refusalWarnings.length, 1);
      const fields = refusalWarnings[0]?.[1] as Record<string, unknown>;
      assert.equal(fields.callerThreadId, "thread-parent");
      assert.match(String(fields.mcpRequestArrivedAt), /^\d{4}-\d\d-\d\dT/);
      assert.equal(fields.failedCheck, "ingress_write_authority_missing");
      assert.equal(fields.registryTurnId, null);
      assert.equal(fields.ingressTurnId, null);
      assert.equal(fields.arrivedOriginTurnId, null);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(gatewayLayer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("logs the current turn evidence when an in-flight write loses authority", () => {
    const warnings: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make(({ message }) => warnings.push(message as ReadonlyArray<unknown>));
    const threads = baseThreads.map((thread) =>
      thread.id === "thread-parent"
        ? makeThreadShell("thread-parent", { latestTurn: null })
        : thread,
    );
    const { gatewayLayer, makeHarness } = makeHarnessLayer(threads, {
      endParentTurnOnSecondShellRead: true,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "Please check the result." },
      });
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      const refusalWarnings = warnings.filter(
        (message) => message[0] === "agent_gateway.caller_turn_inactive",
      );
      assert.equal(refusalWarnings.length, 1);
      const fields = refusalWarnings[0]?.[1] as Record<string, unknown>;
      assert.equal(fields.failedCheck, "authorized_turn_no_longer_active");
      assert.equal(fields.registryTurnId, null);
      assert.equal(fields.ingressTurnId, "turn-parent-active");
      assert.equal(fields.arrivedOriginTurnId, null);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(gatewayLayer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

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
    it.effect(`keeps thread authority after ${replacement} changes turn attribution`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
          pauseAfterCreate: {
            entered,
            release,
          },
        });
        return yield* Effect.gen(function* () {
          const harness = yield* makeHarness;
          harness.setProjectionTurn({
            threadId: "thread-parent",
            turnId: "turn-parent-active",
            providerTurnId: "native-original",
            state: "running",
          });
          const [response] = yield* Effect.all(
            [
              harness.callTool({
                token: "token-parent",
                name: "penkra_create_thread",
                args: {
                  requestId: `authority-${replacement}`,
                  prompt: "Summarize the weather",
                  target: { provider: "codex", model: "gpt-5.5" },
                },
              }),
              Effect.gen(function* () {
                yield* Deferred.await(entered);
                if (replacement === "different-execution") {
                  harness.endTurn("thread-parent", "codex", "turn-parent-active");
                  harness.beginTurn("thread-parent", "codex", "native-next");
                  harness.setProjectionTurn({
                    threadId: "thread-parent",
                    turnId: "turn-parent-active",
                    providerTurnId: "native-original",
                    state: "completed",
                  });
                }
                harness.setProjectionTurn({
                  threadId: "thread-parent",
                  turnId: "zz-followup",
                  providerTurnId:
                    replacement === "same-native-steer" ? "native-original" : "native-next",
                  state: "running",
                });
                yield* Deferred.succeed(release, undefined);
              }),
            ],
            { concurrency: "unbounded" },
          );
          const turnStarts = harness.sent;
          if (replacement === "same-native-steer") {
            assert.isFalse(isToolError(response.result), toolErrorText(response.result));
            assert.equal(turnStarts.length, 1);
          } else {
            assert.isTrue(isToolError(response.result));
            assert.equal(
              (toolResultJson(response.result).error as { code: string }).code,
              "caller_turn_inactive",
            );
            assert.equal(turnStarts.length, 0);
            // The accepted child is retained; a retry uses its client-chosen id.
            assert.equal(harness.dispatched.length, 0);
          }
        }).pipe(Effect.provide(gatewayLayer));
      }),
    );
  }

  it.effect("does not create a child when the caller turn ends before admission dispatch", () => {
    let harness: GatewayHarness;
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      resolveConnection: () => {
        harness.endTurn("thread-parent", "codex", "turn-parent-active");
        harness.beginTurn("thread-parent", "codex", "zz-followup");
        harness.setProjectionTurn({
          threadId: "thread-parent",
          turnId: "turn-parent-active",
          state: "completed",
        });
        harness.setProjectionTurn({
          threadId: "thread-parent",
          turnId: "zz-followup",
          state: "running",
        });
      },
    });
    return Effect.gen(function* () {
      harness = yield* makeHarness;
      harness.setProjectionTurn({
        threadId: "thread-parent",
        turnId: "turn-parent-active",
        state: "running",
      });
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_create_thread",
        args: {
          requestId: "expired-before-dispatch",
          prompt: "Summarize the weather",
          target: { provider: "codex", model: "gpt-5.5" },
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      assert.equal(harness.sent.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("allows a handoff write after an accepted steer shares the running invocation", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (const turnId of ["turn-parent-active", "zz-followup"]) {
        harness.setProjectionTurn({
          threadId: "thread-parent",
          turnId,
          providerTurnId: "native-shared",
          state: "running",
        });
      }
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: {
          threadId: "thread-child",
          message: "The regression checks passed.",
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.equal(harness.sent.length, 1);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects malformed JSON-RPC ids before invoking a tool", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: true,
          method: "tools/call",
          params: {
            name: "penkra_archive_thread",
            arguments: { threadId: "Must not run" },
          },
        },
      });
      assert.equal((response.body as { error?: { code: number } }).error?.code, -32600);
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

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

  it.effect(
    "validates a token against the live session provider instead of the saved model",
    () => {
      const threads = baseThreads.map((thread) =>
        thread.id === "thread-parent"
          ? {
              ...thread,
              session: {
                threadId: thread.id,
                status: "running" as const,
                providerName: "claudeAgent",
                activeTurnId: thread.latestTurn?.turnId ?? null,
                lastError: null,
                updatedAt: NOW,
              },
            }
          : thread,
      );
      const { gatewayLayer, makeHarness } = makeHarnessLayer(threads);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.postRaw({
          authorizationHeader: "Bearer token-parent-claude",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        assert.equal(response.status, 200);
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("answers initialize with instructions and lists tools", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const init = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        },
      });
      assert.equal(init.status, 200);
      const initResult = (init.body as { result: Record<string, unknown> }).result;
      assert.equal(initResult.protocolVersion, "2025-06-18");
      const instructions = initResult.instructions;
      assert.isString(instructions);
      if (typeof instructions !== "string") return;
      assert.equal(instructions, renderPenkraMcpServerInstructions());
      assert.include(instructions, PENKRA_MCP_SERVER_INSTRUCTIONS_MARKER);
      const providerInjections = [
        ["Claude", PENKRA_SYSTEM_PROMPT],
        ["Codex", CODEX_DEVELOPER_INSTRUCTIONS],
        ["OpenCode", takePenkraHostPolicyForSession({}) ?? ""],
      ] as const;
      for (const [provider, injectedText] of providerInjections) {
        const sessionDelivery = `${injectedText}\n${instructions}`;
        const deliveredLines = sessionDelivery.split("\n");
        assert.equal(
          deliveredLines.filter((line) => line === PENKRA_HOST_POLICY_MARKER).length,
          1,
          `${provider} host-policy delivery`,
        );
        assert.equal(
          deliveredLines.filter((line) => line === PENKRA_MCP_SERVER_INSTRUCTIONS_MARKER).length,
          1,
          `${provider} MCP-server-instruction delivery`,
        );
      }

      const list = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      const tools = (
        list.body as {
          result: {
            tools: Array<{
              name: string;
              description?: string;
              inputSchema: { properties?: Record<string, unknown> };
            }>;
          };
        }
      ).result.tools;
      const names = tools.map((tool) => tool.name);
      assert.deepEqual(names, ["penkra_exec_command"]);
      const hostToolSchema = tools[0]!.inputSchema as {
        type: string;
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
      assert.equal(hostToolSchema.type, "object");
      assert.deepEqual(hostToolSchema.required, ["command"]);
      assert.isFalse(hostToolSchema.additionalProperties);
      assert.deepInclude(hostToolSchema.properties.command as object, {
        type: "string",
        minLength: 1,
      });

      assert.notInclude(names, "penkra_create_automation");
      assert.notInclude(names, "penkra_list_automations");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("lists every folder without legacy container filtering", () => {
    // ServerConfig.layerTest canonicalizes the home dir via realpath, so the legacy
    // Home row must use the same canonical form for the workspace-root match to hold.
    const homeDir = realpathSync(homedir());
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      extraFolders: [
        {
          ...makeProjectShell(),
          id: FolderId.makeUnsafe("project-chat-container"),
          title: "che progetti ci sono in penkra",
          workspaceRoot: `${homeDir}/Documents/Penkra/2026-03-01/chat`,
        },
        {
          ...makeProjectShell(),
          id: FolderId.makeUnsafe("project-legacy-home"),
          title: "Home",
          workspaceRoot: homeDir,
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_folders",
        args: {},
      });
      const payload = toolResultJson(response.result);
      const folders = payload.folders as Array<{ folderId: string }>;
      assert.deepEqual(
        folders.map((project) => project.folderId),
        [PROJECT_ID as string, "project-chat-container", "project-legacy-home"],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("exposes exactly the seven ordinary thread commands in help", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_exec_command",
        args: { command: "penkra threads --help" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const text = toolErrorText(response.result);
      const commandNames = ["archive", "create", "interrupt", "list", "read", "send", "unarchive"];
      const exposed = [...text.matchAll(/- `penkra threads ([^` ]+)`/g)].map((match) => match[1]);
      assert.deepEqual(exposed.toSorted(), commandNames);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("shows the simple send example before the model and Connection switch example", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_exec_command",
        args: { command: "penkra threads send --help" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const text = toolErrorText(response.result);
      assert.include(
        text,
        "penkra threads send --thread-id <thread-id> --message 'Continue the review.'",
      );
      assert.include(text, "gpt-6-sol");
      assert.isBelow(
        text.indexOf("Send a follow-up"),
        text.indexOf("Send and switch model and Connection"),
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("separates context, Connections, and model catalogs in root help", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_exec_command",
        args: { command: "penkra --help" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const text = readToolResultFile(response.result);
      assert.include(text, "`penkra context`");
      assert.include(text, "`penkra connections list`");
      assert.include(text, "`penkra models list`");
      assert.notInclude(text, "`penkra capabilities`");
      assert.notInclude(text, "penkra diagnostics");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("returns a file reference for a full over-budget thread-list operation", () => {
    const title = "complete-result-".repeat(1000);
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      makeThreadShell("thread-large-result", { title }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_threads",
        args: { threadId: ["thread-large-result"] },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const reference = toolResultJson(response.result) as { resultFile: string; bytes: number };
      assert.include(reference.resultFile, "/tool-results/thread-parent/");
      const fullText = readFileSync(reference.resultFile, "utf8");
      assert.equal(Buffer.byteLength(fullText), reference.bytes);
      const fullResult = JSON.parse(fullText) as { threads: Array<{ title: string }> };
      assert.equal(fullResult.threads[0]?.title, title);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("lists several exact threads with latest and queued turn summaries", () => {
    const first = makeThreadShell("thread-list-first", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-list-first"),
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const second = makeThreadShell("thread-list-second", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-list-second"),
        state: "queued",
        requestedAt: NOW,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      first,
      second,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setProjectionTurn({
        threadId: second.id,
        turnId: "turn-list-second",
        state: "queued",
      });
      harness.setQueuedPromotion(second.id, "queued");
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_threads",
        args: { threadId: [first.id, second.id] },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const rows = toolResultJson(response.result).threads as Array<{
        threadId: string;
        latestTurn: { turnId: string; state: string } | null;
        queuedTurns: number;
      }>;
      assert.deepEqual(
        rows.map((row) => ({
          threadId: row.threadId,
          latestTurn: row.latestTurn,
          queuedTurns: row.queuedTurns,
        })),
        [
          {
            threadId: second.id,
            latestTurn: { turnId: "turn-list-second", state: "queued" },
            queuedTurns: 1,
          },
          {
            threadId: first.id,
            latestTurn: { turnId: "turn-list-first", state: "running" },
            queuedTurns: 0,
          },
        ],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("does not count a stale queued projection after its promotion was cancelled", () => {
    const stale = makeThreadShell("thread-stale-queue", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-stale-queue"),
        state: "queued",
        requestedAt: NOW,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      stale,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setProjectionTurn({
        threadId: stale.id,
        turnId: "turn-stale-queue",
        state: "queued",
      });
      harness.setQueuedPromotion(stale.id, "cancelled");
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_threads",
        args: { threadId: [stale.id] },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const rows = toolResultJson(response.result).threads as Array<{ queuedTurns: number }>;
      assert.equal(rows[0]?.queuedTurns, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("polls one queued turn with its exact FIFO position", () => {
    const target = makeThreadShell("thread-turn-poll");
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      target,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setProjectionTurn({
        threadId: target.id,
        turnId: "turn-queued-first",
        state: "queued",
      });
      harness.setProjectionTurn({
        threadId: target.id,
        turnId: "turn-queued-second",
        state: "queued",
      });
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_read_thread",
        args: { threadId: target.id, turnId: "turn-queued-second" },
      });
      assert.deepInclude(toolResultJson(response.result), {
        threadId: target.id,
        turn: { turnId: "turn-queued-second", state: "queued", position: 2 },
        items: [],
        pageInfo: { nextCursor: null },
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("collects only assistant output belonging to the requested turn", () => {
    const target = makeThreadShell("thread-turn-result");
    const requestedTurnId = TurnId.makeUnsafe("turn-requested-result");
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), target],
      {
        threadDetails: new Map([
          [
            target.id,
            {
              ...makeThreadDetail(target),
              messages: [
                {
                  id: MessageId.makeUnsafe("message-other-result"),
                  role: "assistant",
                  text: "other answer",
                  turnId: TurnId.makeUnsafe("turn-other-result"),
                  streaming: false,
                  source: "native",
                  createdAt: NOW,
                  updatedAt: NOW,
                },
                {
                  id: MessageId.makeUnsafe("message-requested-result"),
                  role: "assistant",
                  text: "requested answer",
                  turnId: requestedTurnId,
                  streaming: false,
                  source: "native",
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
            },
          ],
        ]),
      },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setProjectionTurn({
        threadId: target.id,
        turnId: requestedTurnId,
        state: "completed",
        assistantMessageId: "message-requested-result",
      });
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_read_thread",
        args: { threadId: target.id, turnId: requestedTurnId },
      });
      const payload = toolResultJson(response.result);
      assert.deepEqual(payload.turn, {
        turnId: requestedTurnId,
        state: "completed",
      });
      assert.deepEqual(
        (payload.items as Array<{ text?: string }>).map((item) => item.text),
        ["requested answer"],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "collects provider-native output after the logical turn's initiating message boundary",
    () => {
      const target = makeThreadShell("thread-logical-provider-result");
      const logicalTurnId = TurnId.makeUnsafe("turn-logical-provider-result");
      const providerTurnId = TurnId.makeUnsafe("turn-provider-native-result");
      const resumedProviderTurnId = TurnId.makeUnsafe("turn-provider-resumed-result");
      const pendingMessageId = MessageId.makeUnsafe("message-logical-provider-request");
      const nextLogicalTurnId = TurnId.makeUnsafe("turn-logical-native-steer");
      const nextPendingMessageId = MessageId.makeUnsafe("message-logical-native-steer");
      const { gatewayLayer, makeHarness } = makeHarnessLayer(
        [makeThreadShell("thread-parent"), target],
        {
          threadDetails: new Map([
            [
              target.id,
              {
                ...makeThreadDetail(target),
                messages: [
                  {
                    id: MessageId.makeUnsafe("message-provider-before-request"),
                    role: "assistant",
                    text: "provider output before the logical dispatch",
                    turnId: providerTurnId,
                    streaming: false,
                    source: "native",
                    sequence: 9,
                    createdAt: "2026-09-05T07:10:59.000Z",
                    updatedAt: "2026-09-05T07:10:59.000Z",
                  },
                  {
                    id: pendingMessageId,
                    role: "user",
                    text: "pivot now",
                    turnId: logicalTurnId,
                    delivery: {
                      state: "accepted",
                      queued: false,
                      sequence: 14,
                    },
                    streaming: false,
                    source: "native",
                    sequence: 10,
                    createdAt: "2026-09-05T07:11:00.000Z",
                    updatedAt: "2026-09-05T07:11:00.000Z",
                  },
                  {
                    id: nextPendingMessageId,
                    role: "user",
                    text: "do this now",
                    turnId: nextLogicalTurnId,
                    delivery: { state: "accepted", queued: true, sequence: 15 },
                    streaming: false,
                    source: "native",
                    sequence: 11,
                    createdAt: "2026-09-05T07:11:01.000Z",
                    updatedAt: "2026-09-05T07:11:04.000Z",
                  },
                  {
                    id: MessageId.makeUnsafe("message-provider-after-request"),
                    role: "assistant",
                    text: "provider output after the logical dispatch",
                    turnId: providerTurnId,
                    streaming: false,
                    source: "native",
                    sequence: 12,
                    createdAt: "2026-09-05T07:11:02.000Z",
                    updatedAt: "2026-09-05T07:11:02.000Z",
                  },
                  {
                    id: MessageId.makeUnsafe("message-provider-after-restart"),
                    role: "assistant",
                    text: "provider output after restart",
                    turnId: resumedProviderTurnId,
                    streaming: false,
                    source: "native",
                    sequence: 13,
                    createdAt: "2026-09-05T07:11:03.000Z",
                    updatedAt: "2026-09-05T07:11:03.000Z",
                  },
                  {
                    id: MessageId.makeUnsafe("message-provider-after-native-steer"),
                    role: "assistant",
                    text: "provider output for the later logical steer",
                    turnId: resumedProviderTurnId,
                    streaming: false,
                    source: "native",
                    sequence: 16,
                    createdAt: "2026-09-05T07:11:06.000Z",
                    updatedAt: "2026-09-05T07:11:06.000Z",
                  },
                ],
              },
            ],
          ]),
        },
      );
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.setProjectionTurn({
          threadId: target.id,
          turnId: logicalTurnId,
          state: "completed",
          pendingMessageId,
          providerTurnId: resumedProviderTurnId,
          providerTurnIds: [providerTurnId, resumedProviderTurnId],
        });
        harness.setProjectionTurn({
          threadId: target.id,
          turnId: nextLogicalTurnId,
          state: "completed",
          pendingMessageId: nextPendingMessageId,
          providerTurnId: resumedProviderTurnId,
          providerTurnIds: [resumedProviderTurnId],
        });
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread",
          args: { threadId: target.id, turnId: logicalTurnId },
        });
        const payload = toolResultJson(response.result);
        assert.deepEqual(payload.turn, {
          turnId: logicalTurnId,
          providerTurnId: resumedProviderTurnId,
          state: "completed",
        });
        assert.deepEqual(
          (payload.items as Array<{ text?: string }>).map((item) => item.text),
          ["provider output after the logical dispatch", "provider output after restart"],
        );
        const nextResponse = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread",
          args: { threadId: target.id, turnId: nextLogicalTurnId },
        });
        const nextPayload = toolResultJson(nextResponse.result);
        assert.deepEqual(nextPayload.turn, {
          turnId: nextLogicalTurnId,
          providerTurnId: resumedProviderTurnId,
          state: "completed",
        });
        assert.deepEqual(
          (nextPayload.items as Array<{ text?: string }>).map((item) => item.text),
          ["provider output for the later logical steer"],
        );
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect(
    "returns round-trippable Penkra turn handles for every provider transcript item",
    () => {
      const fixtures = [
        {
          provider: "codex",
          nativeTurnId: "01a00000-codex-native",
          logicalTurnId: "turn:agent:codex:send",
        },
        {
          provider: "claudeAgent",
          nativeTurnId: "01a00000-0000-4000-8000-000000000001",
          logicalTurnId: "turn:agent:claude:send",
        },
        {
          provider: "opencode",
          nativeTurnId: "opencode-turn-native",
          logicalTurnId: "turn:agent:opencode:send",
        },
      ] as const;
      const targets = fixtures.map(({ provider }, index) =>
        makeThreadShell("thread-turn-contract-" + provider, {
          modelSelection: { provider, model: "test-model" },
        }),
      );
      const details = new Map(
        fixtures.map((fixture, index) => {
          const target = targets[index]!;
          const nativeTurnId = TurnId.makeUnsafe(fixture.nativeTurnId);
          return [
            target.id,
            {
              ...makeThreadDetail(target),
              messages: [
                {
                  id: MessageId.makeUnsafe("message-" + fixture.provider),
                  role: "assistant",
                  text: "answer",
                  turnId: nativeTurnId,
                  streaming: false,
                  source: "native",
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
              activities: [
                {
                  id: EventId.makeUnsafe("activity-tool-" + fixture.provider),
                  tone: "tool" as const,
                  kind: "tool.completed",
                  summary: "Tool call",
                  payload: {},
                  turnId: nativeTurnId,
                  createdAt: NOW,
                },
                {
                  id: EventId.makeUnsafe("activity-task-" + fixture.provider),
                  tone: "info" as const,
                  kind: "task.progress",
                  summary: "Task progress",
                  payload: {},
                  turnId: nativeTurnId,
                  createdAt: NOW,
                },
                {
                  id: EventId.makeUnsafe("activity-turn-" + fixture.provider),
                  tone: "info" as const,
                  kind: "turn.completed",
                  summary: "Turn completed",
                  payload: {},
                  turnId: nativeTurnId,
                  createdAt: NOW,
                },
              ],
            },
          ] as const;
        }),
      );
      const { gatewayLayer, makeHarness } = makeHarnessLayer(
        [makeThreadShell("thread-parent"), ...targets],
        { threadDetails: details },
      );
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        for (let index = 0; index < fixtures.length; index += 1) {
          const fixture = fixtures[index]!;
          const target = targets[index]!;
          const logicalTurnId = TurnId.makeUnsafe(fixture.logicalTurnId);
          const nativeTurnId = TurnId.makeUnsafe(fixture.nativeTurnId);
          harness.setProjectionTurn({
            threadId: target.id,
            turnId: logicalTurnId,
            state: "completed",
            providerTurnId: nativeTurnId,
            providerTurnIds: [nativeTurnId],
          });
          const response = yield* harness.callTool({
            token: "token-parent",
            name: "penkra_read_thread",
            args: { threadId: target.id },
          });
          const payload = toolResultJson(response.result);
          const items = payload.items as Array<Record<string, unknown>>;
          assert.deepEqual(items.map((item) => item.type).toSorted(), [
            "message",
            "task",
            "tool",
            "turn",
          ]);
          for (const item of items) {
            assert.equal(item.turnId, logicalTurnId);
            assert.equal(item.providerTurnId, nativeTurnId);
            const roundTrip = yield* harness.callTool({
              token: "token-parent",
              name: "penkra_read_thread",
              args: { threadId: target.id, turnId: item.turnId },
            });
            assert.deepEqual(toolResultJson(roundTrip.result).turn, {
              turnId: logicalTurnId,
              providerTurnId: nativeTurnId,
              state: "completed",
            });
          }
          const nativeIdAttempt = yield* harness.callTool({
            token: "token-parent",
            name: "penkra_read_thread",
            args: { threadId: target.id, turnId: fixture.nativeTurnId },
          });
          assert.equal(isToolError(nativeIdAttempt.result), true);
          assert.match(toolErrorText(nativeIdAttempt.result), /was not found/u);
        }
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("polls a running turn with its partial streaming output", () => {
    const target = makeThreadShell("thread-turn-running");
    const requestedTurnId = TurnId.makeUnsafe("turn-running-result");
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), target],
      {
        threadDetails: new Map([
          [
            target.id,
            {
              ...makeThreadDetail(target),
              messages: [
                {
                  id: MessageId.makeUnsafe("message-running-result"),
                  role: "assistant",
                  text: "partial answer",
                  turnId: requestedTurnId,
                  streaming: true,
                  source: "native",
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
            },
          ],
        ]),
      },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setProjectionTurn({
        threadId: target.id,
        turnId: requestedTurnId,
        state: "running",
        assistantMessageId: "message-running-result",
      });
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_read_thread",
        args: { threadId: target.id, turnId: requestedTurnId },
      });
      const payload = toolResultJson(response.result);
      assert.deepEqual(payload.turn, {
        turnId: requestedTurnId,
        state: "running",
      });
      assert.deepInclude((payload.items as Array<Record<string, unknown>>)[0] ?? {}, {
        type: "message",
        text: "partial answer",
        streaming: true,
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("returns runnable models with provider-specific target option rules", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_models",
        args: { availability: "available", provider: "codex" },
      });
      const payload = toolResultJson(response.result);
      const items = payload.items as Array<{
        provider: string;
        model: string;
        options: Array<{
          key: string;
          allowedValues: ReadonlyArray<unknown>;
        }>;
      }>;
      assert.equal(payload.availability, "available");
      assert.equal(payload.provider, "codex");
      assert.deepInclude(payload.connection as object, {
        connectionId: CONNECTION_ID,
        provider: "codex",
      });
      assert.deepEqual(
        items
          .find((item) => item.model === "gpt-5.6-terra")
          ?.options.find((option) => option.key === "reasoningEffort")?.allowedValues,
        ["low", "high"],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("lists portable authoring models independently of Connections", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_models",
        args: { availability: "possible", provider: "opencode" },
      });
      const payload = toolResultFileJson(response.result);
      const items = payload.items as Array<{
        provider: string;
        model: string;
        options: Array<Record<string, unknown>>;
      }>;
      assert.equal(payload.total, items.length);
      assert.isTrue(items.length > 0);
      assert.isTrue(items.every((item) => item.provider === "opencode"));
      assert.isTrue(items.some((item) => item.model === "opencode-go/kimi-k3"));
      assert.deepInclude(
        items.find((item) => item.model === "opencode-go/kimi-k3")?.options[0] ?? {},
        {
          key: "agent",
          valueType: "string",
          allowedValues: [],
          allowsCustomValue: true,
        },
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("acknowledges notifications without a body", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      assert.equal(response.status, 202);
      assert.isUndefined(response.body);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "pages folders with shared opaque cursors, no duplicates and a specific invalid-cursor error",
    () => {
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
        extraFolders: Array.from({ length: THREADS_PAGE_SIZE + 3 }, (_, i) => ({
          ...makeProjectShell(),
          id: FolderId.makeUnsafe("folder-page-" + String(i).padStart(2, "0")),
        })),
      });
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const first = toolResultJson(
          (yield* harness.callTool({
            token: "token-parent",
            name: "penkra_list_folders",
            args: {},
          })).result,
        );
        const rows = first.folders as Array<{ folderId: string }>;
        assert.lengthOf(rows, THREADS_PAGE_SIZE);
        const cursor = (first.pageInfo as { nextCursor: string }).nextCursor;
        assert.isString(cursor);
        const second = toolResultJson(
          (yield* harness.callTool({
            token: "token-parent",
            name: "penkra_list_folders",
            args: { cursor },
          })).result,
        );
        const rest = second.folders as Array<{ folderId: string }>;
        assert.lengthOf(rest, 4);
        assert.isNull((second.pageInfo as { nextCursor: string | null }).nextCursor);
        assert.equal(
          new Set([...rows, ...rest].map((row) => row.folderId)).size,
          THREADS_PAGE_SIZE + 4,
        );
        const invalid = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_list_folders",
          args: { cursor: "invalid" },
        });
        assert.isTrue(isToolError(invalid.result));
        assert.include(
          toolErrorText(invalid.result),
          'Argument "cursor" is not a valid folder-list cursor.',
        );
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("lists threads hiding archived ones and marking the caller", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_threads",
        args: {},
      });
      const payload = toolResultJson(response.result);
      const threads = payload.threads as Array<Record<string, unknown>>;
      assert.equal(threads.length, 2);
      assert.isUndefined(threads.find((thread) => thread.threadId === "thread-archived"));
      const self = threads.find((thread) => thread.threadId === "thread-parent");
      assert.equal(self?.isSelf, true);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("returns a durable cursor when the 50-row page truncates the thread list", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      ...Array.from({ length: 51 }, (_, i) => makeThreadShell("thread-page-" + i)),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_threads",
        args: {},
      });
      const payload = toolResultFileJson(response.result);
      const threads = payload.threads as Array<Record<string, unknown>>;
      assert.equal(threads.length, THREADS_PAGE_SIZE);
      assert.isString((payload.pageInfo as { nextCursor: string | null }).nextCursor);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("searches transcript windows across the caller Space with a stable cursor", () => {
    const firstShell = makeThreadShell("thread-search-new", {
      title: "Newer result",
    });
    const secondShell = makeThreadShell("thread-search-old", {
      title: "Older result",
    });
    const firstDetailBase: OrchestrationThread = {
      ...makeThreadDetail(firstShell),
      messages: [
        {
          id: MessageId.makeUnsafe("message-search-new"),
          role: "assistant",
          text: "The architecture uses a durable anchor for every page. ".repeat(THREADS_PAGE_SIZE),
          turnId: TurnId.makeUnsafe("turn-search-new"),
          streaming: false,
          source: "native",
          createdAt: "2026-08-31T12:00:02.000Z",
          updatedAt: "2026-08-31T12:00:02.000Z",
        },
      ],
    };
    const firstDetail: OrchestrationThread = {
      ...firstDetailBase,
      messages: [
        ...firstDetailBase.messages,
        ...Array.from({ length: THREADS_PAGE_SIZE - 1 }, (_, i) => ({
          ...firstDetailBase.messages[0]!,
          id: MessageId.makeUnsafe("message-search-new-" + i),
        })),
      ],
    };
    const secondDetail: OrchestrationThread = {
      ...makeThreadDetail(secondShell),
      messages: [
        {
          id: MessageId.makeUnsafe("message-search-old"),
          role: "user",
          text: "Please explain the earlier architecture decision.",
          turnId: TurnId.makeUnsafe("turn-search-old"),
          streaming: false,
          source: "native",
          createdAt: "2026-08-31T12:00:01.000Z",
          updatedAt: "2026-08-31T12:00:01.000Z",
        },
      ],
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), firstShell, secondShell],
      {
        threadDetails: new Map([
          [firstShell.id, firstDetail],
          [secondShell.id, secondDetail],
        ]),
      },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = toolResultFileJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread",
          args: { query: "architecture", limit: 1 },
        })).result,
      );
      const firstItems = first.items as Array<{
        threadId: string;
        messageId: string;
      }>;
      assert.lengthOf(firstItems, THREADS_PAGE_SIZE);
      assert.equal(first.query, "architecture");
      assert.deepEqual(first.queries, ["architecture"]);
      assert.isTrue(firstItems.every((item) => item.threadId === "thread-search-new"));
      assert.isTrue(firstItems.some((item) => item.messageId === "message-search-new"));
      const cursor = (first.pageInfo as { nextCursor: string | null }).nextCursor;
      assert.isString(cursor);

      const second = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread",
          args: { query: "architecture", limit: 1, cursor },
        })).result,
      );
      const secondItems = second.items as Array<{
        threadId: string;
        messageId: string;
      }>;
      assert.equal(secondItems[0]?.threadId, "thread-search-old");
      assert.equal(secondItems[0]?.messageId, "message-search-old");
      assert.isNull((second.pageInfo as { nextCursor: string | null }).nextCursor);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "searches multiple literals with deterministic filters and returns every occurrence",
    () => {
      const shell = makeThreadShell("thread-search-filtered", {
        title: "Filtered result",
      });
      const detail: OrchestrationThread = {
        ...makeThreadDetail(shell),
        messages: [
          {
            id: MessageId.makeUnsafe("message-search-filtered"),
            role: "user",
            text: "Grouping grouping belongs in one panel.",
            turnId: TurnId.makeUnsafe("turn-search-filtered"),
            streaming: false,
            source: "native",
            createdAt: "2026-09-02T12:00:00.000Z",
            updatedAt: "2026-09-02T12:00:00.000Z",
          },
          {
            id: MessageId.makeUnsafe("message-search-wrong-role"),
            role: "assistant",
            text: "Grouping in one panel.",
            turnId: TurnId.makeUnsafe("turn-search-filtered"),
            streaming: false,
            source: "native",
            createdAt: "2026-09-02T12:00:01.000Z",
            updatedAt: "2026-09-02T12:00:01.000Z",
          },
        ],
      };
      const { gatewayLayer, makeHarness } = makeHarnessLayer(
        [makeThreadShell("thread-parent"), shell],
        { threadDetails: new Map([[shell.id, detail]]) },
      );
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const payload = toolResultJson(
          (yield* harness.callTool({
            token: "token-parent",
            name: "penkra_read_thread",
            args: {
              threadId: shell.id,
              queries: ["grouping", "one panel"],
              queryMode: "all",
              roles: ["user"],
              createdAfter: "2026-09-02T00:00:00.000Z",
              createdBefore: "2026-09-03T00:00:00.000Z",
            },
          })).result,
        );
        const items = payload.items as Array<{
          messageId: string;
          matches: Array<{ queryIndex: number; start: number; end: number }>;
        }>;
        assert.lengthOf(items, 1);
        assert.equal(items[0]?.messageId, "message-search-filtered");
        assert.deepEqual(
          items[0]?.matches.map((match) => match.queryIndex),
          [0, 0, 1],
        );
        assert.deepEqual(payload.queries, ["grouping", "one panel"]);
        assert.equal(payload.queryMode, "all");
        assert.equal(payload.order, "recent");
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("finds mixed-case ASCII literals and overlapping ranges", () => {
    const shell = makeThreadShell("thread-search-ascii", { title: "ASCII search" });
    const detail: OrchestrationThread = {
      ...makeThreadDetail(shell),
      messages: [
        {
          id: MessageId.makeUnsafe("message-search-ascii"),
          role: "user",
          text: "elan banana",
          turnId: TurnId.makeUnsafe("turn-search-ascii"),
          streaming: false,
          source: "native",
          createdAt: "2026-09-02T12:00:00.000Z",
          updatedAt: "2026-09-02T12:00:00.000Z",
        },
      ],
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), shell],
      { threadDetails: new Map([[shell.id, detail]]) },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const payload = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread",
          args: { threadId: shell.id, queries: ["ELAN", "ANA"], queryMode: "all" },
        })).result,
      );
      const items = payload.items as Array<{
        messageId: string;
        matches: Array<{ queryIndex: number; start: number; end: number }>;
      }>;
      assert.lengthOf(items, 1);
      assert.equal(items[0]?.messageId, "message-search-ascii");
      assert.deepEqual(items[0]?.matches, [
        { queryIndex: 0, start: 0, end: 4 },
        { queryIndex: 1, start: 6, end: 9 },
        { queryIndex: 1, start: 8, end: 11 },
      ]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("reads and deduplicates context around several exact message anchors", () => {
    const shell = makeThreadShell("thread-context", { title: "Context" });
    const detail: OrchestrationThread = {
      ...makeThreadDetail(shell),
      messages: [
        {
          id: MessageId.makeUnsafe("message-context-user"),
          role: "user",
          text: "Discuss grouping",
          turnId: TurnId.makeUnsafe("turn-context"),
          streaming: false,
          source: "native",
          createdAt: "2026-09-02T12:00:00.000Z",
          updatedAt: "2026-09-02T12:00:00.000Z",
        },
        {
          id: MessageId.makeUnsafe("message-context-assistant"),
          role: "assistant",
          text: "Use a panel",
          turnId: TurnId.makeUnsafe("turn-context"),
          streaming: false,
          source: "native",
          createdAt: "2026-09-02T12:00:01.000Z",
          updatedAt: "2026-09-02T12:00:01.000Z",
        },
      ],
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), shell],
      { threadDetails: new Map([[shell.id, detail]]) },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const payload = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread",
          args: {
            threadId: shell.id,
            aroundMessageIds: ["message-context-user", "message-context-assistant"],
            beforeTurns: 1,
            afterTurns: 1,
          },
        })).result,
      );
      assert.deepEqual(payload.anchorMessageIds, [
        "message-context-user",
        "message-context-assistant",
      ]);
      assert.equal((payload.items as Array<{ type: string }>).length, 2);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "filters thread discovery by provider, status, title, source, and update window",
    () => {
      const threads = [
        makeThreadShell("thread-parent", {
          title: "Investigate stream gap",
          creationSource: "penkra_mcp",
          updatedAt: "2026-03-02T10:00:00.000Z",
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-running"),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        makeThreadShell("thread-other", {
          title: "Unrelated task",
          modelSelection: { provider: "claudeAgent", model: "opus-4.8" },
          updatedAt: "2026-02-01T10:00:00.000Z",
        }),
      ];
      const { gatewayLayer, makeHarness } = makeHarnessLayer(threads);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_list_threads",
          args: {
            provider: "codex",
            status: "working",
            titleContains: "STREAM",
            createdBy: "penkra-mcp",
            updatedAfter: "2026-03-01T00:00:00.000Z",
            updatedBefore: "2026-03-03T00:00:00.000Z",
          },
        });
        const payload = toolResultJson(response.result);
        assert.isNull((payload.pageInfo as { nextCursor: string | null }).nextCursor);
        assert.equal(
          (payload.threads as Array<{ threadId: string }>)[0]?.threadId,
          "thread-parent",
        );
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect(
    "lists safe Connection identities and discovers concrete or anonymous model routes",
    () => {
      const discoveryInputs: unknown[] = [];
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
        discoverModels: (input) => discoveryInputs.push(input),
      });
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const listed = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_list_connections",
          args: { provider: "codex" },
        });
        assert.isFalse(isToolError(listed.result), toolErrorText(listed.result));
        const connectionsPayload = toolResultJson(listed.result);
        assert.deepInclude((connectionsPayload.items as object[])[0], {
          connectionId: CONNECTION_ID,
          provider: "codex",
        });
        assert.notInclude(JSON.stringify(connectionsPayload), "credentialRef");
        assert.notInclude(JSON.stringify(connectionsPayload), "profileRef");

        const selected = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_list_models",
          args: { availability: "available", connectionId: CONNECTION_ID },
        });
        assert.isFalse(isToolError(selected.result), toolErrorText(selected.result));
        assert.deepInclude(toolResultJson(selected.result).connection as object, {
          connectionId: CONNECTION_ID,
          provider: "codex",
        });
        assert.deepInclude(discoveryInputs[0], {
          provider: "codex",
          connectionId: CONNECTION_ID,
        });
        const free = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_list_models",
          args: {
            availability: "available",
            provider: "opencode",
            connectionId: null,
          },
        });
        assert.isFalse(isToolError(free.result), toolErrorText(free.result));
        assert.deepInclude(discoveryInputs[1], {
          provider: "opencode",
          connectionId: null,
        });
        assert.deepInclude(toolResultJson(free.result).connection as object, {
          connectionId: null,
          provider: "opencode",
        });
        const wrongProvider = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_list_models",
          args: {
            availability: "available",
            provider: "claudeAgent",
            connectionId: CONNECTION_ID,
          },
        });
        assert.isTrue(isToolError(wrongProvider.result));
        assert.equal(discoveryInputs.length, 2);
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect(
    "preserves the existing thread connection instead of resolving a changed default",
    () => {
      const originalAccount = ProviderConnectionId.makeUnsafe("original-account");
      const discoveryInputs: unknown[] = [];
      const existingIds = makeAgentCreationIds(
        `gateway:create:${stableGatewayDigest({ principalKind: "provider-session", principalId: "thread-parent", requestId: "retry-existing" })}`,
      );
      const { gatewayLayer, makeHarness } = makeHarnessLayer(
        [...baseThreads, makeThreadShell(existingIds.threadId, { connectionId: originalAccount })],
        {
          resolveConnection: () => assert.fail("A creation retry must not select a new default"),
          discoverModels: (input) => discoveryInputs.push(input),
        },
      );
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const args = {
          requestId: "retry-existing",
          prompt: "Analyze the feature",
          target: { provider: "codex", model: "gpt-5.5" },
        };
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_create_thread",
          args,
        });
        assert.isFalse(isToolError(response.result), toolErrorText(response.result));
        assert.equal(toolResultJson(response.result).connectionId, originalAccount);
        assert.deepInclude(discoveryInputs[0], {
          provider: "codex",
          connectionId: originalAccount,
        });
        assert.equal(harness.getThread(existingIds.threadId)!.connectionId, originalAccount);
        assert.equal(harness.sent.length, 1);
        const count = harness.dispatched.length;
        const conflict = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_create_thread",
          args: { ...args, connectionId: CONNECTION_ID },
        });
        assert.isTrue(isToolError(conflict.result));
        assert.include(toolErrorText(conflict.result), "different Connection");
        assert.equal(harness.dispatched.length, count);
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("forwards an explicit Connection before discovering or creating a thread", () => {
    const selections: unknown[] = [];
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      resolveConnection: (input) => selections.push(input),
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_create_thread",
        args: {
          requestId: "explicit-connection",
          prompt: "Analyze this feature",
          connectionId: CONNECTION_ID,
          target: { provider: "codex", model: "gpt-5.5" },
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.deepEqual(selections, [
        {
          modelSelection: { provider: "codex", model: "gpt-5.5" },
          connectionId: CONNECTION_ID,
        },
      ]);
      assert.equal(toolResultJson(response.result).connectionId, CONNECTION_ID);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates a standalone OpenCode thread and dispatches the initial turn", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_create_thread",
        args: {
          requestId: "create-opencode",
          prompt: "analyze the feature",
          target: { provider: "opencode", model: "openai/gpt-5" },
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.provider, "opencode");
      assert.equal(typeof payload.messageId, "string");
      assert.equal(typeof payload.turnId, "string");

      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.sent.length, 1);
      const created = harness.getThread(payload.threadId as string)!;
      assert.equal(created.modelSelection.provider, "opencode");
      assert.equal(created.folderId, PROJECT_ID);
      assert.equal(created.runtimeMode, "approval-required");
      assert.equal(created.title, "analyze the feature");
      assert.equal(harness.sent[0]!.message.dispatchOrigin, "agent");
      assert.equal(harness.sent[0]!.message.text, "analyze the feature");
      assert.equal(payload.messageId, harness.sent[0]!.message.messageId);
      assert.equal(payload.turnId, "provider-confirmed-turn");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("allows one exact plan in a new active turn even when unrelated threads exist", () => {
    const crowded = [
      makeThreadShell("thread-parent"),
      ...Array.from({ length: 12 }, (_, index) => makeThreadShell(`thread-other-${index}`)),
    ];
    const { gatewayLayer, makeHarness } = makeHarnessLayer(crowded);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_create_thread",
        args: {
          requestId: "create-crowded",
          prompt: "one more",
          target: { provider: "codex", model: "gpt-5.5" },
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.sent.length, 1);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "authorizes the canonical active execution when latestTurn is a newer terminal summary",
    () => {
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        harness.setProjectionTurn({
          threadId: "thread-parent",
          turnId: "turn-parent-active",
          state: "running",
        });
        harness.setThreadDetail(
          makeThreadDetail(
            makeThreadShell("thread-parent", {
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-newer-terminal-summary"),
                state: "completed",
                requestedAt: "2026-08-31T12:24:18.000Z",
                startedAt: "2026-08-31T12:24:19.000Z",
                completedAt: "2026-08-31T12:24:20.000Z",
                assistantMessageId: null,
              },
            }),
          ),
        );

        const context = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_context",
          args: {},
        });
        const contextCaller = toolResultJson(context.result).caller as
          | { readonly turnId?: unknown }
          | undefined;
        assert.equal(contextCaller?.turnId, "turn-parent-active");

        const response = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_create_thread",
          args: {
            requestId: "create-while-summary-points-elsewhere",
            prompt: "continue the verified work",
            target: { provider: "codex", model: "gpt-5.5" },
          },
        });
        assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("accepts calls with no active turn and while turn projection lags", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setThreadDetail(
        makeThreadDetail(makeThreadShell("thread-parent", { session: null, latestTurn: null })),
      );
      const noTurn = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_context",
        args: {},
      });
      assert.isFalse(isToolError(noTurn.result), toolErrorText(noTurn.result));
      assert.equal((toolResultJson(noTurn.result).caller as { turnId?: unknown }).turnId, null);

      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            latestTurn: null,
            session: {
              threadId: ThreadId.makeUnsafe("thread-parent"),
              status: "running",
              providerName: "codex",
              activeTurnId: TurnId.makeUnsafe("native-turn-ahead-of-projection"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ),
      );
      const duringLag = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_context",
        args: {},
      });
      assert.isFalse(isToolError(duringLag.result), toolErrorText(duringLag.result));
      assert.equal(
        (toolResultJson(duringLag.result).caller as { turnId?: unknown }).turnId,
        "native-turn-ahead-of-projection",
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("attributes explicit origin, then live session turn, then none", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const explicit = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_context",
        args: {},
        originTurnId: "origin-turn-a",
      });
      assert.equal(
        (toolResultJson(explicit.result).caller as { turnId?: unknown }).turnId,
        "origin-turn-a",
      );
      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            session: {
              threadId: ThreadId.makeUnsafe("thread-parent"),
              status: "running",
              providerName: "codex",
              activeTurnId: TurnId.makeUnsafe("live-turn-b"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ),
      );
      const fallback = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_context",
        args: {},
      });
      assert.equal(
        (toolResultJson(fallback.result).caller as { turnId?: unknown }).turnId,
        "live-turn-b",
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects archived and deleted caller threads", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            archivedAt: NOW,
          }),
        ),
      );
      const archived = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "penkra_exec_command",
            arguments: { command: "penkra context" },
          },
        },
      });
      assert.equal(archived.status, 401);
      assert.include(JSON.stringify(archived.body), "caller_thread_inactive");
      harness.setThreadDetail(makeThreadDetail(makeThreadShell("thread-parent")));
      harness.revokeToken("token-parent-second");
      const tornDown = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent-second",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "penkra_exec_command",
            arguments: { command: "penkra context" },
          },
        },
      });
      assert.equal(tornDown.status, 401);
      harness.deleteThread("thread-parent");
      const deleted = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "penkra_exec_command",
            arguments: { command: "penkra context" },
          },
        },
      });
      assert.equal(deleted.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("sends a follow-up message with the agent dispatch origin", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads.filter((thread) => thread.id !== "thread-child"),
      makeThreadShell("thread-child", {
        session: {
          threadId: ThreadId.makeUnsafe("thread-child"),
          status: "running",
          providerName: "codex",
          activeTurnId: TurnId.makeUnsafe("turn-live"),
          lastError: null,
          updatedAt: NOW,
        },
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const spoofed = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: {
          threadId: "thread-child",
          message: "status check please",
          senderThreadId: "thread-spoofed",
          now: true,
          connectionId: CONNECTION_ID,
          modelSelection: {
            provider: "codex",
            model: "gpt-5.5",
            options: { reasoningEffort: "high" },
          },
        },
      });
      assert.isTrue(isToolError(spoofed.result));
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "status check please", now: true },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const turn = harness.sent[0]!;
      if (turn) {
        assert.equal(turn.message.dispatchOrigin, "agent");
        assert.equal(turn.message.senderThreadId, ThreadId.makeUnsafe("thread-parent"));
        assert.equal(turn.dispatchMode, "steer");
        assert.isUndefined(turn.connectionId);
        assert.isUndefined(turn.modelSelection);
        assert.equal(turn.threadId, "thread-child");
        assert.equal(toolResultJson(response.result).turnId, "provider-confirmed-turn");
        assert.equal(toolResultJson(response.result).messageId, turn.message.messageId);
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("preserves FIFO delivery by default without exposing the internal mechanism", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: {
          threadId: "thread-child",
          message: "follow the existing work",
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.strictEqual("dispatched" in payload, false);
      const turn = harness.sent[0];
      if (turn) {
        assert.equal(turn.dispatchMode, "queue");
        assert.equal(payload.messageId, turn.message.messageId);
        assert.equal(payload.turnId, "provider-confirmed-turn");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("forwards an explicit anonymous route and model selection on queued sends", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: {
          threadId: "thread-child",
          message: "Use the anonymous route for this follow-up.",
          connectionId: null,
          modelSelection: {
            provider: "codex",
            model: "gpt-5.5",
            options: { reasoningEffort: "low" },
          },
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const turn = harness.sent[0];
      if (turn) {
        assert.equal(turn.dispatchMode, "queue");
        assert.equal(turn.connectionId, null);
        assert.deepEqual(turn.modelSelection, {
          provider: "codex",
          model: "gpt-5.5",
          options: { reasoningEffort: "low" },
        });
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("returns the selection failure message unchanged", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      sendSelectionError: {
        code: "connection_unavailable",
        message:
          "The selected Connection can't be used for this thread. Choose a Connection for the thread's provider.",
      },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "Try the selected route." },
      });
      assert.isFalse(isToolError(response.result));
      assert.equal(toolResultJson(response.result).delivery, "failed");
      assert.equal(
        toolResultJson(response.result).error,
        "The selected Connection can't be used for this thread. Choose a Connection for the thread's provider.",
      );
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
    it.effect(`returns ${code} as a structured send error`, () => {
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
        sendSelectionError: { code, message },
      });
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_send_message",
          args: { threadId: "thread-child", message: "Try the selected route." },
        });
        assert.isFalse(isToolError(response.result));
        assert.equal(toolResultJson(response.result).delivery, "failed");
        assert.equal(toolResultJson(response.result).error, message);
      }).pipe(Effect.provide(gatewayLayer));
    });
  }

  it.effect("passes an idle steer through so the reactor's live-state guard decides", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: {
          threadId: "thread-child",
          message: "status check please",
          now: true,
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      // The projection snapshot can lag the runtime in both directions, so
      // the gateway must not downgrade; the reactor rechecks live state.
      assert.equal(typeof toolResultJson(response.result).turnId, "string");
      const turn = harness.sent[0]!;
      if (turn) {
        assert.equal(turn.dispatchMode, "steer");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("cancels a queued message by message id without a turn handle", () => {
    const target = makeThreadShell("thread-cancel-queued");
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      target,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_interrupt_thread",
        args: { messageId: "message-cancel-queued" },
      });
      assert.deepInclude(toolResultJson(response.result), {
        threadId: target.id,
        messageId: "message-cancel-queued",
        removed: true,
      });
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects sends that would drive a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: {
          threadId: "thread-full-access",
          message: "run something dangerous",
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects self-targeted sends before they fabricate a stacked user turn", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-parent", message: "continue" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "agent-authored message with user role");
      assert.include(toolErrorText(response.result), "starts another turn");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects interrupts that would drive a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_interrupt_thread",
        args: { threadId: "thread-full-access" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects tokens whose caller thread no longer exists", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-ghost",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects runtime-mode escalation beyond the calling thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_create_thread",
        args: {
          requestId: "create-escalated",
          prompt: "escalate please",
          target: { provider: "codex", model: "gpt-5.5" },
          runtimeMode: "full-access",
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "approval-required");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("archives threads through the public meta command", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.callTool({
        token: "token-parent",
        name: "penkra_archive_thread",
        args: { threadId: "thread-child" },
      });
      assert.equal(harness.dispatched.length, 0);
      assert.isNotNull(harness.getThread("thread-child")!.archivedAt);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("returns thread_archived synchronously from threads send", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      rejectArchivedCommands: true,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "Continue." },
      });
      assert.isFalse(isToolError(response.result));
      assert.equal(toolResultJson(response.result).delivery, "failed");
      assert.equal(
        toolResultJson(response.result).error,
        "This thread is archived. Unarchive it to send messages.",
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        0,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("returns thread_running synchronously from threads archive", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      rejectRunningArchive: true,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_archive_thread",
        args: { threadId: "thread-child" },
      });
      assert.isTrue(isToolError(response.result));
      assert.deepStrictEqual(toolResultJson(response.result).error, {
        code: "thread_running",
        message: "This thread is still running. Stop it before archiving.",
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects metadata changes when the caller cannot drive the target thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-elevated", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;

      const archive = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_archive_thread",
        args: { threadId: "thread-elevated" },
      });
      assert.isTrue(isToolError(archive.result));
      assert.include(toolErrorText(archive.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("reports unknown tools as invalid params", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "penkra_unknown" },
        },
      });
      const error = (response.body as { error?: { code: number } }).error;
      assert.equal(error?.code, -32602);
    }).pipe(Effect.provide(gatewayLayer));
  });
});

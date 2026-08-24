import { assert, describe, it } from "@effect/vitest";
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationFolderShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProviderKind,
  ServerProviderStatus,
  ThreadId as ThreadIdType,
} from "@penkra/contracts";
import {
  EventId,
  MessageId,
  ModelSelection,
  FolderId,
  ProviderConnectionId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@penkra/contracts";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import {
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
  type ProviderRuntimeProjectionFailure,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ThreadDiagnosticsQuery } from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import type {
  DiagnosticThreadActivity,
  OperationalDiagnostic,
} from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import type { ProviderBlockingDeliveryEvidence } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentGateway } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayLive } from "./AgentGateway.ts";
import { AgentGatewayToolBridgeLive } from "./AgentGatewayToolBridge.ts";
import { ProviderTurnSelectionResolver } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { ProviderThreadSwitchCoordinator } from "../../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { penkraRootInstructions } from "../../appRuntimeCli.ts";
import { CODEX_DEVELOPER_INSTRUCTIONS } from "../../codexAppServerManager.ts";
import { PENKRA_SYSTEM_PROMPT } from "../../provider/Layers/ClaudeAdapter.ts";
import {
  PENKRA_HOST_POLICY_MARKER,
  PENKRA_SERVER_MANUAL_MARKER,
  takePenkraHostPolicyForSession,
} from "../harnessPolicy.ts";

const NOW = "2026-03-01T10:00:00.000Z";
const PROJECT_ID = FolderId.makeUnsafe("project-1");
const SPACE_ID = SpaceId.makeUnsafe("space-personal");
const CONNECTION_ID = ProviderConnectionId.makeUnsafe("connection-default");

function makeProjectShell(
  scripts: OrchestrationFolderShell["scripts"] = [],
): OrchestrationFolderShell {
  return {
    id: PROJECT_ID,
    spaceId: SPACE_ID,
    title: "Demo project",
    workspaceRoot: "/tmp/demo",
    defaultModelSelection: null,
    scripts,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

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
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
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
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    session: null,
    ...overrides,
  };
}

function makeThreadDetail(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    pinnedMessages: [],
    messages: [],
    activities: [],
  };
}

interface GatewayHarness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly setThreadDetail: (thread: OrchestrationThread) => void;
  readonly deleteThread: (threadId: string) => void;
  readonly setProjectionTurn: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly state: "pending" | "running" | "completed" | "error" | "interrupted";
    readonly assistantMessageId?: string | null;
  }) => void;
  readonly setProviderStatuses: (statuses: ReadonlyArray<ServerProviderStatus>) => void;
  readonly getWaitReadCounts: () => {
    readonly detailReads: number;
    readonly batchTurnReads: number;
  };
  readonly callTool: (input: {
    readonly token: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  }) => Effect.Effect<{ status: number; result: Record<string, unknown> | undefined }>;
  readonly postRaw: (input: {
    readonly authorizationHeader: string | undefined;
    readonly body: unknown;
  }) => Effect.Effect<{ status: number; body?: unknown }>;
}

const VALID_TOKENS: Record<string, string> = {
  "token-parent": "thread-parent",
  "token-parent-claude": "thread-parent",
  "token-parent-readonly": "thread-parent",
  "token-ghost": "thread-ghost",
};

const TEST_TOOL_COMMANDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  penkra_context: ["penkra", "context"],
  penkra_capabilities: ["penkra", "capabilities"],
  penkra_list_folders: ["penkra", "folders", "list"],
  penkra_list_threads: ["penkra", "threads", "list"],
  penkra_read_thread: ["penkra", "threads", "read"],
  penkra_wait_for_threads: ["penkra", "threads", "wait"],
  penkra_read_thread_activity: ["penkra", "threads", "activity"],
  penkra_read_thread_events: ["penkra", "threads", "events"],
  penkra_read_thread_runtime_events: ["penkra", "threads", "runtime-events"],
  penkra_diagnose_thread: ["penkra", "threads", "diagnose"],
  penkra_retry_thread_projection: ["penkra", "threads", "retry-projection"],
  penkra_create_thread: ["penkra", "threads", "create"],
  penkra_send_message: ["penkra", "threads", "send"],
  penkra_interrupt_thread: ["penkra", "threads", "interrupt"],
  penkra_set_thread_title: ["penkra", "threads", "rename"],
  penkra_archive_thread: ["penkra", "threads", "archive"],
  penkra_unarchive_thread: ["penkra", "threads", "unarchive"],
};

function testCommandForTool(
  name: string,
  args: Record<string, unknown>,
): { command: ReadonlyArray<string>; input: Record<string, unknown> } | undefined {
  const command = TEST_TOOL_COMMANDS[name];
  return command ? { command, input: args } : undefined;
}

function makeHarnessLayer(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  options: {
    readonly threadDetails?: ReadonlyMap<string, OrchestrationThread>;
    readonly failDispatch?: (command: OrchestrationCommand) => boolean;
    readonly dispatchDelayMs?: number;
    readonly providerStatuses?: ReadonlyArray<ServerProviderStatus>;
    readonly pauseAfterDispatch?: {
      readonly commandType: OrchestrationCommand["type"];
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly advanceParentTurnAfterDispatch?: {
      readonly commandType: OrchestrationCommand["type"];
      readonly turnId: string;
      readonly state?: "running" | "completed" | "interrupted";
    };
    readonly projectScripts?: OrchestrationFolderShell["scripts"];
    readonly extraFolders?: ReadonlyArray<OrchestrationFolderShell>;
    readonly diagnosticActivities?: ReadonlyArray<DiagnosticThreadActivity>;
    readonly diagnosticEvents?: ReadonlyArray<OrchestrationEvent>;
    readonly providerRuntimeEvents?: ReadonlyArray<PersistedProviderRuntimeEvent>;
    readonly providerRuntimeProjectionFailure?: ProviderRuntimeProjectionFailure;
    readonly operationalDiagnostics?: ReadonlyArray<OperationalDiagnostic>;
    readonly providerDeliveryBlockers?: ReadonlyArray<ProviderBlockingDeliveryEvidence>;
  } = {},
) {
  const dispatched: Array<OrchestrationCommand> = [];

  const credentialsLayer = Layer.succeed(AgentGatewayCredentials, {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: (threadId: ThreadIdType) => `token-for-${threadId}`,
    verifySessionToken: (token: string) => VALID_TOKENS[token] ?? null,
    verifySession: (token: string) => {
      const threadId = VALID_TOKENS[token];
      return threadId
        ? {
            sessionKey: `session-for-${threadId}`,
            threadId: ThreadId.makeUnsafe(threadId),
            provider:
              token === "token-parent-claude" ? ("claudeAgent" as const) : ("codex" as const),
            issuedAt: 0,
            capabilities:
              token === "token-parent-readonly"
                ? new Set(["thread:read"] as const)
                : new Set(["thread:read", "thread:write", "diagnostics:read"] as const),
          }
        : null;
    },
    bindWriteAuthority: (token: string, turnId: string) => {
      const threadId = VALID_TOKENS[token];
      return threadId
        ? {
            sessionKey: `session-for-${threadId}`,
            threadId: ThreadId.makeUnsafe(threadId),
            provider:
              token === "token-parent-claude" ? ("claudeAgent" as const) : ("codex" as const),
            turnId,
          }
        : null;
    },
    verifyWriteAuthority: (authority) =>
      authority.sessionKey === `session-for-${authority.threadId}`,
    revokeSessionToken: () => undefined,
    connectionForThread: (threadId: ThreadIdType) => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `token-for-${threadId}`,
    }),
    stdioProxy: { command: "node", args: ["/tmp/proxy.mjs"] },
  });

  const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));
  const threadDetailsById = new Map(options.threadDetails ?? []);
  const projectionTurnsByKey = new Map<
    string,
    {
      readonly threadId: string;
      readonly turnId: string;
      readonly state: "pending" | "running" | "completed" | "error" | "interrupted";
      readonly assistantMessageId: string | null;
    }
  >();
  let threadDetailReads = 0;
  let batchTurnReads = 0;

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        folders: [makeProjectShell(options.projectScripts), ...(options.extraFolders ?? [])],
        threads: [...threadsById.values()],
        updatedAt: NOW,
      }),
    getThreadShellById: (threadId: ThreadIdType) =>
      Effect.succeed(Option.fromNullishOr(threadsById.get(threadId as string))),
    getFolderShellById: (folderId: string) =>
      Effect.succeed(
        folderId === (PROJECT_ID as string)
          ? Option.some(makeProjectShell(options.projectScripts))
          : Option.none<OrchestrationFolderShell>(),
      ),
    getThreadDetailById: (threadId: ThreadIdType) =>
      Effect.sync(() => {
        threadDetailReads += 1;
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
  } as unknown as (typeof ProjectionSnapshotQuery)["Service"]);

  const diagnosticsLayer = Layer.succeed(ThreadDiagnosticsQuery, {
    getActivityCoverage: (threadId: string) =>
      Effect.succeed({
        highWaterSequence: Math.max(
          0,
          ...(options.diagnosticActivities ?? [])
            .filter((activity) => activity.threadId === threadId)
            .map((activity) => activity.sequence),
        ),
        unsequencedCount: 0,
      }),
    listActivities: (input: {
      threadId: string;
      throughSequenceInclusive?: number;
      beforeSequenceExclusive?: number;
      limit: number;
      turnId?: string;
      kinds?: ReadonlyArray<string>;
    }) =>
      Effect.succeed(
        (options.diagnosticActivities ?? [])
          .filter((activity) => activity.threadId === input.threadId)
          .filter(
            (activity) =>
              activity.sequence <= (input.throughSequenceInclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter(
            (activity) =>
              activity.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter((activity) => input.turnId === undefined || activity.turnId === input.turnId)
          .filter((activity) => input.kinds === undefined || input.kinds.includes(activity.kind))
          .toSorted((left, right) => right.sequence - left.sequence)
          .slice(0, input.limit),
      ),
    recordOperationalDiagnostic: () => Effect.void,
    listOperationalDiagnostics: (input: { threadId: string; limit: number }) =>
      Effect.succeed(
        (options.operationalDiagnostics ?? [])
          .filter((incident) => incident.threadId === input.threadId)
          .slice(0, input.limit),
      ),
  });
  const eventStoreLayer = Layer.succeed(OrchestrationEventStore, {
    append: () => Effect.die("append is not used by the gateway harness"),
    getHighWaterSequence: () => Effect.succeed(0),
    getThreadHighWaterSequence: (threadId: string) =>
      Effect.succeed(
        Math.max(
          0,
          ...(options.diagnosticEvents ?? [])
            .filter((event) => event.aggregateId === threadId)
            .map((event) => event.sequence),
        ),
      ),
    readThreadEvents: (input: {
      threadId: string;
      throughSequenceInclusive: number;
      beforeSequenceExclusive?: number;
      limit: number;
      eventTypes?: ReadonlyArray<string>;
    }) =>
      Effect.succeed(
        (options.diagnosticEvents ?? [])
          .filter((event) => event.aggregateId === input.threadId)
          .filter((event) => event.sequence <= input.throughSequenceInclusive)
          .filter(
            (event) => event.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter(
            (event) => input.eventTypes === undefined || input.eventTypes.includes(event.type),
          )
          .toSorted((left, right) => right.sequence - left.sequence)
          .slice(0, input.limit),
      ),
    readFromSequence: () => Stream.empty,
    readAll: () => Stream.empty,
  });
  const eventDeliveriesLayer = Layer.succeed(OrchestrationEventDeliveryRepository, {
    listBlockingDeliveries: (input: { threadId?: string; limit: number }) =>
      Effect.succeed(
        (options.providerDeliveryBlockers ?? [])
          .filter((blocker) => input.threadId === undefined || blocker.threadId === input.threadId)
          .slice(0, input.limit),
      ),
  } as unknown as (typeof OrchestrationEventDeliveryRepository)["Service"]);
  const providerRuntimeEventsLayer = Layer.succeed(ProviderRuntimeEventRepository, {
    getThreadCursor: () => Effect.succeed(0),
    getThreadProjectionFailure: (threadId: string) =>
      Effect.succeed(
        options.providerRuntimeProjectionFailure?.threadId === threadId
          ? options.providerRuntimeProjectionFailure
          : null,
      ),
    releaseQuarantinedThread: (input: { threadId: string }) =>
      Effect.succeed(
        options.providerRuntimeProjectionFailure?.threadId === input.threadId &&
          options.providerRuntimeProjectionFailure.status === "quarantined",
      ),
    getThreadCoverage: (threadId: string) => {
      const events = (options.providerRuntimeEvents ?? []).filter(
        (row) => row.event.threadId === threadId,
      );
      return Effect.succeed({
        retainedCount: events.length,
        oldestSequence: events.length === 0 ? null : Math.min(...events.map((row) => row.sequence)),
        highWaterSequence: Math.max(0, ...events.map((row) => row.sequence)),
      });
    },
    readThreadEvents: (input: {
      threadId: string;
      throughSequenceInclusive: number;
      beforeSequenceExclusive?: number;
      limit: number;
      turnId?: string;
      eventTypes?: ReadonlyArray<string>;
    }) =>
      Effect.succeed(
        (options.providerRuntimeEvents ?? [])
          .filter((row) => row.event.threadId === input.threadId)
          .filter((row) => row.sequence <= input.throughSequenceInclusive)
          .filter(
            (row) => row.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter((row) => input.turnId === undefined || row.event.turnId === input.turnId)
          .filter(
            (row) => input.eventTypes === undefined || input.eventTypes.includes(row.event.type),
          )
          .toSorted((left, right) => right.sequence - left.sequence)
          .slice(0, input.limit),
      ),
  } as unknown as (typeof ProviderRuntimeEventRepository)["Service"]);

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sleep(options.dispatchDelayMs ?? 0).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() => {
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
                }),
              );
            }
            const result = options.failDispatch?.(command)
              ? Effect.fail(new Error("injected dispatch failure"))
              : Effect.succeed({ sequence: dispatched.length });
            if (options.pauseAfterDispatch?.commandType !== command.type) return result;
            return Deferred.succeed(options.pauseAfterDispatch.entered, undefined).pipe(
              Effect.andThen(Deferred.await(options.pauseAfterDispatch.release)),
              Effect.andThen(result),
            );
          }),
        ),
      ),
  } as unknown as (typeof OrchestrationEngineService)["Service"]);
  const providerTurnSelectionResolverLayer = Layer.succeed(ProviderTurnSelectionResolver, {
    resolveNewThreadConnection: () => Effect.succeed(CONNECTION_ID),
  } as unknown as (typeof ProviderTurnSelectionResolver)["Service"]);
  const providerThreadSwitchCoordinatorLayer = Layer.effect(
    ProviderThreadSwitchCoordinator,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      return {
        dispatchTurnStart: ({ command }: { readonly command: OrchestrationCommand }) =>
          engine.dispatch(command),
        recoverOpen: Effect.void,
      } as unknown as (typeof ProviderThreadSwitchCoordinator)["Service"];
    }),
  ).pipe(Layer.provide(engineLayer));

  const providerDiscoveryLayer = Layer.succeed(ProviderDiscoveryService, {
    listModels: ({ provider }: { provider: string }) => {
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
      return Effect.succeed({ models: modelsByProvider[provider] ?? [], source: "test" });
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
    updateProvider: () => Effect.die("Provider updates are not used by gateway tests."),
    streamChanges: Stream.empty,
  } as unknown as (typeof ProviderHealth)["Service"]);

  const readProjectionTurn = (threadId: string, turnId: string) => {
    const pinned = projectionTurnsByKey.get(`${threadId}:${turnId}`);
    if (pinned) {
      return {
        threadId: ThreadId.makeUnsafe(pinned.threadId),
        turnId: TurnId.makeUnsafe(pinned.turnId),
        pendingMessageId: null,
        assistantMessageId:
          pinned.assistantMessageId === null
            ? null
            : MessageId.makeUnsafe(pinned.assistantMessageId),
        state: pinned.state,
        requestedAt: NOW,
        startedAt: pinned.state === "pending" ? null : NOW,
        completedAt:
          pinned.state === "completed" || pinned.state === "error" || pinned.state === "interrupted"
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
    getByTurnId: ({ threadId, turnId }: { threadId: string; turnId: string }) =>
      Effect.succeed(Option.fromNullishOr(readProjectionTurn(threadId, turnId))),
    getManyByTurnId: (input: ReadonlyArray<{ threadId: string; turnId: string }>) =>
      Effect.sync(() => {
        batchTurnReads += 1;
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
        batchTurnReads += 1;
        return {
          existingThreadIds: input.threadIds.filter((threadId) => threadsById.has(threadId)),
          turns: input.turns.flatMap(({ threadId, turnId }) => {
            const turn = readProjectionTurn(threadId, turnId);
            return turn ? [turn] : [];
          }),
        };
      }),
  } as unknown as (typeof ProjectionTurnRepository)["Service"]);

  const gatewayLayer = AgentGatewayLive.pipe(
    Layer.provide(AgentGatewayToolBridgeLive),
    Layer.provide(credentialsLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(engineLayer),
    Layer.provide(providerTurnSelectionResolverLayer),
    Layer.provide(providerThreadSwitchCoordinatorLayer),
    Layer.provide(providerDiscoveryLayer),
    Layer.provide(providerHealthLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(projectionTurnsLayer),
    Layer.provide(diagnosticsLayer),
    Layer.provide(eventStoreLayer),
    Layer.provide(eventDeliveriesLayer),
    Layer.provide(providerRuntimeEventsLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provide(NodeServices.layer),
  );

  const makeHarness = Effect.gen(function* () {
    const gateway = yield* AgentGateway;
    const postRaw: GatewayHarness["postRaw"] = (input) => gateway.handleMcpPost(input);
    const callTool: GatewayHarness["callTool"] = ({ token, name, args }) => {
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
      setThreadDetail: (thread) => {
        threadsById.set(thread.id, thread);
        threadDetailsById.set(thread.id, thread);
      },
      deleteThread: (threadId) => {
        threadsById.delete(threadId);
        threadDetailsById.delete(threadId);
      },
      setProjectionTurn: (input) => {
        projectionTurnsByKey.set(`${input.threadId}:${input.turnId}`, {
          threadId: input.threadId,
          turnId: input.turnId,
          state: input.state,
          assistantMessageId: input.assistantMessageId ?? null,
        });
      },
      setProviderStatuses: (statuses) => {
        providerStatuses = statuses;
      },
      getWaitReadCounts: () => ({
        detailReads: threadDetailReads,
        batchTurnReads,
      }),
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
    makeThreadShell("thread-child", { parentThreadId: ThreadId.makeUnsafe("thread-parent") }),
    makeThreadShell("thread-archived", { archivedAt: NOW }),
  ];

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
          params: { name: "penkra_set_thread_title", arguments: { title: "Must not run" } },
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
                runtimeMode: thread.runtimeMode,
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

  it.effect("requires the explicit diagnostics capability for forensic tools", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent-readonly",
        name: "penkra_diagnose_thread",
        args: { threadId: "thread-parent" },
      });
      const error = toolResultJson(response.result).error as {
        code: string;
        details: { requiredCapability: string };
      };
      assert.equal(error.code, "capability_denied");
      assert.equal(error.details.requiredCapability, "diagnostics:read");
    }).pipe(Effect.provide(gatewayLayer));
  });

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
      assert.equal(
        instructions,
        penkraRootInstructions(
          [],
          Object.values(TEST_TOOL_COMMANDS).map((words) => words.join(" ")),
        ),
      );
      const providerInjections = [
        ["Claude", PENKRA_SYSTEM_PROMPT],
        ["Codex", CODEX_DEVELOPER_INSTRUCTIONS],
        ["OpenCode", takePenkraHostPolicyForSession({}) ?? ""],
      ] as const;
      for (const [provider, injectedText] of providerInjections) {
        const sessionDelivery = `${injectedText}\n${instructions}`;
        assert.equal(
          sessionDelivery.split(PENKRA_HOST_POLICY_MARKER).length - 1,
          1,
          `${provider} host-policy delivery`,
        );
        assert.equal(
          sessionDelivery.split(PENKRA_SERVER_MANUAL_MARKER).length - 1,
          1,
          `${provider} server-manual delivery`,
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
      assert.property(tools[0]?.inputSchema.properties, "command");

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

  it.effect("returns provider-specific target option keys before the model catalog", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_capabilities",
        args: {},
      });
      const payload = toolResultJson(response.result);
      const targetConstruction = payload.targetConstruction as Record<
        string,
        Record<string, unknown>
      >;

      assert.equal(targetConstruction.codex?.primaryOptionKey, "reasoningEffort");
      assert.deepEqual(
        (targetConstruction.codex?.exampleTarget as { options?: unknown } | undefined)?.options,
        {
          reasoningEffort: "medium",
        },
      );
      const codexOptionsByModel = targetConstruction.codex?.optionsByModel as
        | Record<string, Array<{ key: string; allowedValues: ReadonlyArray<unknown> }>>
        | undefined;
      assert.deepEqual(
        codexOptionsByModel?.["gpt-5.6-terra"]?.find((option) => option.key === "reasoningEffort")
          ?.allowedValues,
        ["low", "high"],
      );
      assert.equal(targetConstruction.claudeAgent?.primaryOptionKey, "effort");
      assert.deepEqual(
        (targetConstruction.claudeAgent?.exampleTarget as { options?: unknown } | undefined)
          ?.options,
        { effort: "low" },
      );
      assert.deepEqual(Object.keys(targetConstruction).toSorted(), [
        "claudeAgent",
        "codex",
        "opencode",
      ]);

      for (const construction of Object.values(targetConstruction)) {
        const exampleTarget = construction.exampleTarget;
        if (exampleTarget === null || exampleTarget === undefined) continue;
        assert.deepEqual(Schema.decodeUnknownSync(ModelSelection)(exampleTarget), exampleTarget);
      }

      const serialized = JSON.stringify(payload);
      assert.isBelow(serialized.indexOf('"targetConstruction"'), serialized.indexOf('"providers"'));
      const providers = payload.providers as Array<{
        models: Array<Record<string, unknown>>;
      }>;
      assert.isTrue(providers.length > 0);
      assert.deepEqual(Object.keys(providers[0]!.models[0]!).toSorted(), ["name", "slug"]);

      const filteredResponse = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_capabilities",
        args: { provider: "codex", detail: "full" },
      });
      const filteredPayload = toolResultJson(filteredResponse.result);
      assert.deepEqual(Object.keys(filteredPayload.targetConstruction as object), ["codex"]);
      const filteredProviders = filteredPayload.providers as Array<{
        provider: string;
        models: Array<Record<string, unknown>>;
      }>;
      assert.equal(filteredProviders.length, 1);
      assert.equal(filteredProviders[0]?.provider, "codex");
      assert.isTrue(filteredProviders[0]!.models.some((model) => Object.keys(model).length > 2));
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

  it.effect("reports the full matching count when the limit truncates the thread list", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_list_threads",
        args: { limit: 1 },
      });
      const payload = toolResultJson(response.result);
      const threads = payload.threads as Array<Record<string, unknown>>;
      assert.equal(threads.length, 1);
      assert.equal(payload.totalMatching, 2);
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
            creationSource: "penkra_mcp",
            updatedAfter: "2026-03-01T00:00:00.000Z",
            updatedBefore: "2026-03-03T00:00:00.000Z",
          },
        });
        const payload = toolResultJson(response.result);
        assert.equal(payload.totalMatching, 1);
        assert.equal(
          (payload.threads as Array<{ threadId: string }>)[0]?.threadId,
          "thread-parent",
        );
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("pages thread activity with an opaque stable cursor", () => {
    const activities: ReadonlyArray<DiagnosticThreadActivity> = [1, 2, 3].map((sequence) => ({
      activityId: `activity-${sequence}`,
      threadId: "thread-parent",
      turnId: "turn-parent",
      tone: "info",
      kind: "tool",
      summary: `activity ${sequence}`,
      payload: { sequence },
      sequence,
      createdAt: NOW,
    }));
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      diagnosticActivities: activities,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread_activity",
          args: { threadId: "thread-parent", limit: 1, includeDetails: true },
        })).result,
      );
      assert.equal((first.activities as Array<{ sequence: number }>)[0]?.sequence, 3);
      assert.isString(first.nextCursor);
      const second = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread_activity",
          args: { threadId: "thread-parent", limit: 1, cursor: first.nextCursor },
        })).result,
      );
      assert.equal((second.activities as Array<{ sequence: number }>)[0]?.sequence, 2);
      assert.deepInclude(second.coverage as Record<string, unknown>, {
        highWaterSequence: 3,
        sourceComplete: true,
      });
      const changedFilter = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_read_thread_activity",
        args: {
          threadId: "thread-parent",
          limit: 1,
          kinds: ["error"],
          cursor: first.nextCursor,
        },
      });
      assert.isTrue(isToolError(changedFilter.result));
      assert.include(toolErrorText(changedFilter.result), "not a valid activity cursor");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("paginates coalesced message updates as one logical event", () => {
    const threadId = ThreadId.makeUnsafe("thread-parent");
    const messageEvents = Array.from({ length: 301 }, (_, index) => {
      const sequence = index + 2;
      return {
        sequence,
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe(`event-message-${sequence}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-streamed"),
          role: "assistant",
          text: `delta-${sequence}`,
          turnId: TurnId.makeUnsafe("turn-parent"),
          streaming: sequence !== 302,
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as OrchestrationEvent;
    });
    const olderEvent = {
      sequence: 1,
      type: "thread.archived",
      eventId: EventId.makeUnsafe("event-archived-1"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: NOW,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { threadId, archivedAt: NOW, updatedAt: NOW },
    } as OrchestrationEvent;
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      diagnosticEvents: [olderEvent, ...messageEvents],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread_events",
          args: { threadId, limit: 1 },
        })).result,
      );
      assert.deepInclude((first.events as Array<Record<string, unknown>>)[0] ?? {}, {
        sequence: 302,
        coalescedEventCount: 301,
      });
      assert.isString(first.nextCursor);

      const second = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_read_thread_events",
          args: { threadId, limit: 1, cursor: first.nextCursor },
        })).result,
      );
      assert.deepInclude((second.events as Array<Record<string, unknown>>)[0] ?? {}, {
        sequence: 1,
        type: "thread.archived",
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("combines durable events, delivery blockers, and stream incidents in diagnosis", () => {
    const threadId = ThreadId.makeUnsafe("thread-parent");
    const events: ReadonlyArray<OrchestrationEvent> = [
      {
        sequence: 7,
        type: "thread.archived",
        eventId: EventId.makeUnsafe("event-diagnostic-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, archivedAt: NOW, updatedAt: NOW },
      },
    ];
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, {
      diagnosticEvents: events,
      providerRuntimeEvents: [
        {
          sequence: 9,
          event: {
            type: "runtime.error",
            eventId: EventId.makeUnsafe("runtime-event-diagnostic-9"),
            provider: "codex",
            threadId,
            turnId: TurnId.makeUnsafe("turn-parent"),
            createdAt: NOW,
            payload: { message: "stream failed" },
          },
        },
      ],
      providerRuntimeProjectionFailure: {
        sequence: 9,
        eventId: "runtime-event-diagnostic-9",
        threadId: "thread-parent",
        turnId: "turn-parent",
        eventType: "runtime.error",
        errorFingerprint: "projection-fingerprint",
        errorDetail: "projection failed deterministically",
        attemptCount: 12,
        firstFailedAt: NOW,
        lastFailedAt: NOW,
        nextRetryAt: NOW,
        status: "quarantined",
        quarantinedAt: NOW,
        resolvedAt: null,
      },
      operationalDiagnostics: [
        {
          sequence: 1,
          threadId: "thread-parent",
          source: "server",
          kind: "ws.stream-admission-rejected",
          severity: "warning",
          code: "THREAD_STREAM_CAPACITY_EXCEEDED",
          detail: { reason: "thread-capacity" },
          occurredAt: NOW,
        },
      ],
      providerDeliveryBlockers: [
        {
          consumerName: "provider-command-reactor.v1",
          eventSequence: 7,
          eventId: EventId.makeUnsafe("event-diagnostic-7"),
          eventType: "thread.turn-start-requested",
          occurredAt: NOW,
          threadId,
          state: "dead",
          attemptCount: 3,
          lastError: "provider failed",
          updatedAt: NOW,
          lastReconciliationOutcome: null,
          lastReconciledAt: null,
          lastReconciledBy: null,
          lastReconciliationNote: null,
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const payload = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_diagnose_thread",
          args: { threadId: "thread-parent" },
        })).result,
      );
      assert.equal((payload.recentEvents as Array<{ sequence: number }>)[0]?.sequence, 7);
      assert.equal((payload.recentRuntimeEvents as Array<{ sequence: number }>)[0]?.sequence, 9);
      assert.lengthOf(payload.providerDeliveryBlockers as Array<unknown>, 1);
      assert.deepInclude(payload.providerRuntimeProjection as Record<string, unknown>, {
        threadCursor: 0,
      });
      assert.equal(
        (
          payload.providerRuntimeProjection as {
            failure: { status: string; errorFingerprint: string };
          }
        ).failure.status,
        "quarantined",
      );
      assert.lengthOf(payload.operationalIncidents as Array<unknown>, 1);
      assert.includeMembers(
        (payload.findings as Array<{ code: string }>).map((finding) => finding.code),
        [
          "provider_delivery_blocked",
          "provider_runtime_projection_quarantined",
          "THREAD_STREAM_CAPACITY_EXCEEDED",
        ],
      );
      const retryPayload = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "penkra_retry_thread_projection",
          args: { threadId: "thread-parent" },
        })).result,
      );
      assert.equal(retryPayload.released, true);
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
      assert.strictEqual("parentThreadId" in payload, false);

      assert.equal(harness.dispatched.length, 3);
      const create = harness.dispatched[0]!;
      assert.equal(create.type, "thread.create");
      if (create.type === "thread.create") {
        // Gateway-created threads are ordinary top-level threads, not subagents.
        assert.strictEqual("parentThreadId" in create, false);
        assert.strictEqual("subagentNickname" in create, false);
        assert.equal(create.modelSelection.provider, "opencode");
        // Project and runtime mode default from the calling thread.
        assert.equal(create.folderId, PROJECT_ID);
        assert.equal(create.runtimeMode, "approval-required");
        // Same placeholder title flow as UI threads so the first-turn reactor
        // replaces it with a model-generated title.
        assert.equal(create.title, "analyze the feature");
      }
      const turn = harness.dispatched[1]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchOrigin, "agent");
        assert.equal(turn.message.text, "analyze the feature");
      }
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
      assert.equal(harness.dispatched.length, 3);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("waits for two pinned terminal turns without creating replacements", () => {
    const first = makeThreadShell("thread-result-a", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-result-a"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: MessageId.makeUnsafe("message-result-a"),
      },
    });
    const second = makeThreadShell("thread-result-b", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-result-b"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: MessageId.makeUnsafe("message-result-b"),
      },
    });
    const firstDetail: OrchestrationThread = {
      ...makeThreadDetail(first),
      messages: [
        {
          id: MessageId.makeUnsafe("message-result-a"),
          role: "assistant",
          text: "First result",
          turnId: TurnId.makeUnsafe("turn-result-a"),
          streaming: false,
          source: "native",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const secondDetail: OrchestrationThread = {
      ...makeThreadDetail(second),
      messages: [
        {
          id: MessageId.makeUnsafe("message-result-b"),
          role: "assistant",
          text: "Second result",
          turnId: TurnId.makeUnsafe("turn-result-b"),
          streaming: false,
          source: "native",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), first, second],
      {
        threadDetails: new Map([
          ["thread-result-a", firstDetail],
          ["thread-result-b", secondDetail],
        ]),
      },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_wait_for_threads",
        args: { threadIds: ["thread-result-a", "thread-result-b"], timeoutMs: 0 },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.allTerminal, true);
      assert.deepEqual(payload.runIds, ["turn-result-a", "turn-result-b"]);
      assert.deepEqual(
        (payload.threads as Array<{ summary: string }>).map((entry) => entry.summary),
        ["First result", "Second result"],
      );
      assert.deepEqual(harness.getWaitReadCounts(), { detailReads: 2, batchTurnReads: 1 });
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("bounds wait summaries and points callers to paginated thread reads", () => {
    const runId = TurnId.makeUnsafe("turn-long-result");
    const messageId = MessageId.makeUnsafe("message-long-result");
    const shell = makeThreadShell("thread-long-result", {
      latestTurn: {
        turnId: runId,
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: messageId,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), shell],
      {
        threadDetails: new Map([
          [
            "thread-long-result",
            {
              ...makeThreadDetail(shell),
              messages: [
                {
                  id: messageId,
                  role: "assistant",
                  text: "x".repeat(5_000),
                  turnId: runId,
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
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_wait_for_threads",
        args: { threadIds: ["thread-long-result"], timeoutMs: 0 },
      });
      const result = (
        toolResultJson(response.result).threads as Array<Record<string, unknown>>
      )[0]!;
      assert.equal(result.summaryTruncated, true);
      assert.match(result.summary as string, /\[\.\.\. truncated \d+ chars\]$/);
      assert.equal((result.summary as string).length, 2_000);
      assert.deepEqual(result.readThread, {
        tool: "penkra_read_thread",
        arguments: { threadId: "thread-long-result" },
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "checks twenty pending waits with one batched turn read and no transcript loads",
    () => {
      const pending = Array.from({ length: 20 }, (_, index) =>
        makeThreadShell(`thread-pending-${index}`, {
          latestTurn: {
            turnId: TurnId.makeUnsafe(`turn-pending-${index}`),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      );
      const { gatewayLayer, makeHarness } = makeHarnessLayer([
        makeThreadShell("thread-parent"),
        ...pending,
      ]);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "penkra_wait_for_threads",
          args: { threadIds: pending.map((thread) => thread.id), timeoutMs: 0 },
        });
        assert.equal(toolResultJson(response.result).timedOut, true);
        assert.deepEqual(harness.getWaitReadCounts(), { detailReads: 0, batchTurnReads: 1 });
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("fails a long wait when a pinned thread is deleted between polls", () => {
    const running = makeThreadShell("thread-deleted-during-wait", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-deleted-during-wait"),
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      running,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fiber = yield* harness
        .callTool({
          token: "token-parent",
          name: "penkra_wait_for_threads",
          args: { threadIds: ["thread-deleted-during-wait"], timeoutMs: 5_000 },
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(harness.getWaitReadCounts().batchTurnReads, 1);
      harness.deleteThread("thread-deleted-during-wait");
      yield* TestClock.adjust("200 millis");
      const response = yield* Fiber.join(fiber);
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "thread_not_found",
      );
      assert.equal(harness.getWaitReadCounts().detailReads, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("wait reports idle, failure, timeout, and a later-completed pinned run", () => {
    const idle = makeThreadShell("thread-wait-idle");
    const failed = makeThreadShell("thread-wait-failed", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-wait-failed"),
        state: "error",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-wait-failed"),
        status: "error",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: "Child failed",
        updatedAt: NOW,
      },
    });
    const running = makeThreadShell("thread-wait-running", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-wait-pinned"),
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      idle,
      failed,
      running,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_wait_for_threads",
        args: {
          threadIds: ["thread-wait-idle", "thread-wait-failed", "thread-wait-running"],
          timeoutMs: 0,
        },
      });
      const firstThreads = toolResultJson(first.result).threads as Array<{
        state: string;
        timedOut: boolean;
        error: string | null;
      }>;
      assert.deepEqual(
        firstThreads.map(({ state, timedOut }) => ({ state, timedOut })),
        [
          { state: "idle", timedOut: false },
          { state: "error", timedOut: false },
          { state: "running", timedOut: true },
        ],
      );
      assert.equal(firstThreads[1]?.error, "Child failed");

      harness.setProjectionTurn({
        threadId: "thread-wait-running",
        turnId: "turn-wait-pinned",
        state: "completed",
        assistantMessageId: "message-wait-pinned",
      });
      harness.setThreadDetail({
        ...makeThreadDetail(
          makeThreadShell("thread-wait-running", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-wait-later"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        ),
        messages: [
          {
            id: MessageId.makeUnsafe("message-wait-pinned"),
            role: "assistant",
            text: "Pinned run finished",
            turnId: TurnId.makeUnsafe("turn-wait-pinned"),
            streaming: false,
            source: "native",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-parent-active"),
              state: "interrupted",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
          }),
        ),
      );
      const second = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_wait_for_threads",
        args: {
          threadIds: ["thread-wait-running"],
          runIds: ["turn-wait-pinned"],
          timeoutMs: 0,
        },
      });
      const secondThread = (
        toolResultJson(second.result).threads as Array<{
          state: string;
          summary: string;
        }>
      )[0];
      assert.equal(secondThread?.state, "completed");
      assert.equal(secondThread?.summary, "Pinned run finished");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("sends a follow-up message with the agent dispatch origin", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads.filter((thread) => thread.id !== "thread-child"),
      makeThreadShell("thread-child", {
        parentThreadId: ThreadId.makeUnsafe("thread-parent"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-child"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("turn-live"),
          lastError: null,
          updatedAt: NOW,
        },
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "status check please", mode: "steer" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const turn = harness.dispatched[0]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchOrigin, "agent");
        assert.equal(turn.dispatchMode, "steer");
        assert.equal(turn.threadId, "thread-child");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("passes an idle steer through so the reactor's live-state guard decides", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_send_message",
        args: { threadId: "thread-child", message: "status check please", mode: "steer" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      // The projection snapshot can lag the runtime in both directions, so
      // the gateway must not downgrade; the reactor rechecks live state.
      assert.equal(toolResultJson(response.result).dispatched, "steer");
      const turn = harness.dispatched[0]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchMode, "steer");
      }
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
        args: { threadId: "thread-full-access", message: "run something dangerous" },
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

  it.effect("archives and renames threads through meta commands", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.callTool({
        token: "token-parent",
        name: "penkra_set_thread_title",
        args: { threadId: "thread-child", title: "Renamed worker" },
      });
      yield* harness.callTool({
        token: "token-parent",
        name: "penkra_archive_thread",
        args: { threadId: "thread-child" },
      });
      assert.equal(harness.dispatched[0]?.type, "thread.update");
      assert.equal(harness.dispatched[1]?.type, "thread.archive");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects metadata changes when the caller cannot drive the target thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-elevated", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;

      const rename = yield* harness.callTool({
        token: "token-parent",
        name: "penkra_set_thread_title",
        args: { threadId: "thread-elevated", title: "Hidden work" },
      });
      assert.isTrue(isToolError(rename.result));
      assert.include(toolErrorText(rename.result), "full-access");

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

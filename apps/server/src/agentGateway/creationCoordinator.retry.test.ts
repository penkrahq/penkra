import {
  FolderId,
  CommandId,
  ProviderNativeStateGenerationId,
  ProviderConnectionId,
  ProviderInstallationId,
  SpaceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationFolderShell,
  type OrchestrationThreadShell,
  type PenkraCreateThreadInput,
  type ProviderKind,
  type ProviderListModelsInput,
  type ThreadRuntimeBinding,
} from "@penkra/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderValidationError } from "../provider/Errors.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderTurnSelectionResolverShape } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderThreadSwitchCoordinatorShape } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import type { ThreadDiagnosticsQueryShape } from "../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import { ProviderThreadSwitchCoordinatorError } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { makeAgentCreationIds, stableGatewayDigest } from "./creationUtils.ts";
import { makeCreateThreadHandler, type GatewayCreationContext } from "./creationCoordinator.ts";
import type { AgentGatewayProviderAvailability } from "./targetResolver.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { ToolInputError, errorText } from "./toolInput.ts";

import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import type { AgentGatewayCreationAdmission } from "../persistence/Services/AgentGatewayCreationAdmissions.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { AgentGatewayCreationAdmissionRepository } from "../persistence/Services/AgentGatewayCreationAdmissions.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { AgentGatewayCreationAdmissionRepositoryLive } from "../persistence/Layers/AgentGatewayCreationAdmissions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";

const NOW = "2026-09-06T08:00:00.000Z";
const CALLER_THREAD_ID = ThreadId.makeUnsafe("caller-retry");
const CALLER_TURN_ID = TurnId.makeUnsafe("caller-turn");
const FOLDER_ID = FolderId.makeUnsafe("folder-retry");
const SPACE_ID = SpaceId.makeUnsafe("space-retry");
const ACCOUNT_A = ProviderConnectionId.makeUnsafe("account-a");
const ACCOUNT_B = ProviderConnectionId.makeUnsafe("account-b");
const INSTALLATION_ID = ProviderInstallationId.makeUnsafe("installation-retry");
const TARGET: ModelSelection = { provider: "codex", model: "gpt-5.5" };
const INPUT: PenkraCreateThreadInput = {
  requestId: "retry-request",
  prompt: "synthetic retry task",
  target: TARGET,
};

const FOLDER: OrchestrationFolderShell = {
  id: FOLDER_ID,
  spaceId: SPACE_ID,
  title: "Synthetic folder",
  workspaceRoot: "/synthetic/retry",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const CALLER: OrchestrationThreadShell = {
  id: CALLER_THREAD_ID,
  folderId: FOLDER_ID,
  title: "Synthetic caller",
  modelSelection: TARGET,
  runtimeMode: "full-access",
  isPinned: false,
  parentThreadId: null,
  subagentAgentId: null,
  subagentNickname: null,
  subagentRole: null,
  forkSourceThreadId: null,
  latestTurn: null,
  latestUserMessageAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  session: null,
};

function expectedIds() {
  const operationId = `gateway:create:${stableGatewayDigest({
    principalKind: "provider-session",
    principalId: CALLER_THREAD_ID,
    callerTurnId: CALLER_TURN_ID,
    requestId: INPUT.requestId,
  })}`;
  const ids = makeAgentCreationIds(operationId, 0);
  return {
    ...ids,
    operationId,
    turnId: TurnId.makeUnsafe(`turn:${ids.turnStartCommandId}`),
  };
}

function makeBinding(
  connectionId: ProviderConnectionId,
  threadId: ThreadId,
  revision: number,
): ThreadRuntimeBinding {
  return {
    threadId,
    connectionId,
    installationId: INSTALLATION_ID,
    internalProviderId: null,
    modelId: TARGET.model,
    revision,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type CreationDependencies = Parameters<typeof makeCreateThreadHandler>[0];

interface HarnessOptions {
  readonly existingBinding?: ThreadRuntimeBinding;
  readonly defaultConnection?: ProviderConnectionId;
  readonly discoveryFailure?: boolean;
  readonly rejectStaleBinding?: boolean;
  readonly diagnosticWriteFailure?: boolean;
}

interface Harness {
  readonly dependencies: CreationDependencies;
  readonly engineCommands: Array<OrchestrationCommand>;
  readonly turnStartAttempts: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>>;
  readonly successfulTurnStarts: Array<
    Extract<OrchestrationCommand, { type: "thread.turn.start" }>
  >;
  readonly modelDiscoveryCalls: Array<ProviderListModelsInput>;
  readonly selectionCalls: number;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const admissions = new Map<string, AgentGatewayCreationAdmission>();
  const engineCommands: Array<OrchestrationCommand> = [];
  const turnStartAttempts: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = [];
  const successfulTurnStarts: Array<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> =
    [];
  const modelDiscoveryCalls: Array<ProviderListModelsInput> = [];
  let selectionCalls = 0;

  const snapshotQuery: ProjectionSnapshotQueryShape = {
    getCommandReadModel: () => Effect.die("unused snapshot method"),
    getSnapshot: () => Effect.die("unused snapshot method"),
    getCounts: () => Effect.die("unused snapshot method"),
    getSnapshotSequence: () => Effect.die("unused snapshot method"),
    listStaleInFlightThreadIds: () => Effect.die("unused snapshot method"),
    listOpenTurnCounts: () => Effect.die("unused snapshot method"),
    listStreamingAssistantMessages: () => Effect.die("unused snapshot method"),
    getShellSnapshot: () => Effect.die("unused snapshot method"),
    getActiveFolderByWorkspaceRoot: () => Effect.die("unused snapshot method"),
    getFolderShellById: () => Effect.succeed(Option.some(FOLDER)),
    getSpaceShellById: () => Effect.die("unused snapshot method"),
    getFirstActiveThreadIdByFolderId: () => Effect.die("unused snapshot method"),
    listGeneratedImageActivitiesByTurn: () => Effect.die("unused snapshot method"),
    getThreadShellById: () => Effect.succeed(Option.none()),
    findSyntheticSubagentParentThread: () => Effect.die("unused snapshot method"),
    getThreadDetailById: () => Effect.die("unused snapshot method"),
    getThreadDetailForExportById: () => Effect.die("unused snapshot method"),
    getThreadDetailSnapshotById: () => Effect.die("unused snapshot method"),
    getThreadTurnsPage: () => Effect.die("unused snapshot method"),
    getPendingStartOutcome: () => Effect.die("unused snapshot method"),
  };

  const orchestrationEngine: OrchestrationEngineShape = {
    quiesce: Effect.void,
    drain: Effect.void,
    stop: Effect.void,
    getProjectionCatchUpStatus: Effect.die("unused engine method"),
    readEvents: () => Stream.empty,
    readEventsThrough: () => Stream.empty,
    getEventHighWaterSequence: Effect.die("unused engine method"),
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    getReadModel: () => Effect.die("unused engine method"),
    getCommandReadModel: () => Effect.die("unused engine method"),
    dispatch: (command) => {
      engineCommands.push(command);
      return Effect.succeed({ sequence: engineCommands.length });
    },
    repairState: () => Effect.die("unused engine method"),
    refreshCommandReadModel: () => Effect.die("unused engine method"),
    streamDomainEvents: Stream.empty,
  };

  const providerDiscovery: ProviderDiscoveryServiceShape = {
    getComposerCapabilities: () => Effect.die("unused discovery method"),
    getCapabilityHealth: () => Effect.die("unused discovery method"),
    listCommands: () => Effect.die("unused discovery method"),
    listSkills: () => Effect.die("unused discovery method"),
    listPlugins: () => Effect.die("unused discovery method"),
    readPlugin: () => Effect.die("unused discovery method"),
    listModels: (input) => {
      modelDiscoveryCalls.push(input);
      if (options.discoveryFailure) {
        return Effect.fail(
          new ProviderValidationError({
            operation: "listModels",
            issue: "synthetic discovery failure",
          }),
        );
      }
      return Effect.succeed({
        models: [{ slug: TARGET.model, name: "Synthetic model" }],
        source: "synthetic",
      });
    },
    listAgents: () => Effect.die("unused discovery method"),
  };

  const providerTurnSelectionResolver: ProviderTurnSelectionResolverShape = {
    resolveNewThreadConnection: () => {
      selectionCalls += 1;
      return Effect.succeed(options.defaultConnection ?? ACCOUNT_A);
    },
    resolveInitial: () => Effect.die("unused selection method"),
    resolveExisting: () => Effect.die("unused selection method"),
  };

  const providerThreadSwitchCoordinator: ProviderThreadSwitchCoordinatorShape = {
    dispatchTurnStart: ({ command }) => {
      turnStartAttempts.push(command);
      if (options.rejectStaleBinding && command.bindingRevision === 0) {
        return Effect.fail(
          new ProviderThreadSwitchCoordinatorError({
            detail: "synthetic stale binding revision",
          }),
        );
      }
      successfulTurnStarts.push(command);
      return Effect.succeed({ sequence: successfulTurnStarts.length });
    },
    recoverOpen: Effect.void,
  };

  const availabilities: ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability> = new Map([
    ["codex", { enabled: true, available: true, authStatus: "authenticated" }],
  ]);

  const diagnostics: ThreadDiagnosticsQueryShape = {
    getActivityCoverage: () => Effect.die("unused diagnostics method"),
    listActivities: () => Effect.die("unused diagnostics method"),
    recordOperationalDiagnostic: () =>
      options.diagnosticWriteFailure
        ? Effect.fail(
            new PersistenceSqlError({
              operation: "test.diagnostic",
              detail: "controlled diagnostic writer failure",
            }),
          )
        : Effect.void,
    listOperationalDiagnostics: () => Effect.die("unused diagnostics method"),
  };

  const dependencies: CreationDependencies = {
    diagnostics,
    admissions: {
      get: (operationId) => Effect.succeed(Option.fromNullishOr(admissions.get(operationId))),
      reserve: (admission) =>
        Effect.sync(() => {
          const existing = admissions.get(admission.operationId);
          if (existing) return { kind: "existing" as const, admission: existing };
          admissions.set(admission.operationId, admission);
          return { kind: "reserved" as const, admission };
        }),
    },
    commandReceipts: {
      insert: () => Effect.die("unused receipt method"),
      getByCommandId: () => Effect.succeed(Option.none()),
    },
    loadExistingBinding: () => Effect.succeed(Option.fromNullishOr(options.existingBinding)),
    snapshotQuery,
    orchestrationEngine,
    providerDiscovery,
    providerTurnSelectionResolver,
    providerThreadSwitchCoordinator,
    loadProviderAvailabilities: Effect.succeed(availabilities),
    requireThreadShell: () => Effect.succeed(CALLER),
  };

  return {
    dependencies,
    engineCommands,
    turnStartAttempts,
    successfulTurnStarts,
    modelDiscoveryCalls,
    get selectionCalls() {
      return selectionCalls;
    },
  };
}

const CONTEXT: GatewayCreationContext = {
  kind: "provider-session",
  callerThreadId: CALLER_THREAD_ID,
  callerTurnId: CALLER_TURN_ID,
  assertAuthority: () => Effect.void,
  attachmentPrincipal: { ownerKind: "session", ownerId: "synthetic-session" },
};

async function invoke(
  harness: Harness,
  input: PenkraCreateThreadInput = INPUT,
): Promise<McpToolCallResult> {
  const handler = await Effect.runPromise(makeCreateThreadHandler(harness.dependencies));
  return Effect.runPromise(handler(input, CONTEXT));
}

function resultText(result: McpToolCallResult): string {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected a text MCP result");
  return block.text;
}

function threadCreateCommands(harness: Harness) {
  return harness.engineCommands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
      command.type === "thread.create",
  );
}

describe("create thread retry characterization", () => {
  it("keeps deterministic thread, message, and turn IDs for the same caller execution and request ID", async () => {
    const harness = makeHarness();
    const ids = expectedIds();

    const first = await invoke(harness);
    const retry = await invoke(harness);

    for (const result of [first, retry]) {
      expect(resultText(result)).toContain(String(ids.threadId));
      expect(resultText(result)).toContain(String(ids.messageId));
      expect(resultText(result)).toContain(String(ids.turnId));
      expect(resultText(result)).toContain(ids.operationId);
    }
    const creates = threadCreateCommands(harness);
    expect(creates).toHaveLength(2);
    expect(creates.map((command) => command.commandId)).toEqual([
      ids.threadCreateCommandId,
      ids.threadCreateCommandId,
    ]);
    expect(creates.map((command) => command.threadId)).toEqual([ids.threadId, ids.threadId]);
    expect(harness.successfulTurnStarts).toHaveLength(2);
    expect(harness.successfulTurnStarts.map((command) => command.commandId)).toEqual([
      ids.turnStartCommandId,
      ids.turnStartCommandId,
    ]);
    expect(harness.successfulTurnStarts.map((command) => command.message.messageId)).toEqual([
      ids.messageId,
      ids.messageId,
    ]);
    expect(harness.successfulTurnStarts.map((command) => command.turnId)).toEqual([
      ids.turnId,
      ids.turnId,
    ]);
  });

  it("keeps an existing account A binding when the host default changes to account B", async () => {
    const ids = expectedIds();
    const harness = makeHarness({
      existingBinding: makeBinding(ACCOUNT_A, ids.threadId, 0),
      defaultConnection: ACCOUNT_B,
    });

    const result = await invoke(harness);
    const creates = threadCreateCommands(harness);

    expect(resultText(result)).toContain(String(ACCOUNT_A));
    expect(harness.selectionCalls).toBe(0);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.threadId).toBe(ids.threadId);
    expect(harness.successfulTurnStarts).toHaveLength(1);
    expect(harness.successfulTurnStarts[0]?.connectionId).toBe(ACCOUNT_A);
    expect(harness.successfulTurnStarts[0]?.bindingRevision).toBe(0);
  });

  it("rejects explicit account B against an existing account A binding before any dispatch", async () => {
    const ids = expectedIds();
    const harness = makeHarness({ existingBinding: makeBinding(ACCOUNT_A, ids.threadId, 0) });

    const result = await invoke(harness, { ...INPUT, connectionId: ACCOUNT_B });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(
      "already created a thread with a different Connection. It cannot be rerouted by retrying creation.",
    );
    expect(harness.engineCommands).toHaveLength(0);
    expect(harness.turnStartAttempts).toHaveLength(0);
    expect(harness.selectionCalls).toBe(0);
    expect(harness.modelDiscoveryCalls).toHaveLength(0);
  });

  it("characterizes current stale-binding rejection without rerouting or successfully starting a second request", async () => {
    const ids = expectedIds();
    const harness = makeHarness({
      existingBinding: makeBinding(ACCOUNT_A, ids.threadId, 1),
      defaultConnection: ACCOUNT_B,
      rejectStaleBinding: true,
    });

    const result = await invoke(harness);
    const creates = threadCreateCommands(harness);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("synthetic stale binding revision");
    expect(harness.selectionCalls).toBe(0);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.threadId).toBe(ids.threadId);
    expect(harness.turnStartAttempts).toHaveLength(1);
    expect(harness.turnStartAttempts[0]?.connectionId).toBe(ACCOUNT_A);
    expect(harness.turnStartAttempts[0]?.bindingRevision).toBe(0);
    expect(harness.successfulTurnStarts).toHaveLength(0);
  });

  it("keeps the gateway failure when retaining its diagnostic fails", async () => {
    const harness = makeHarness({
      existingBinding: makeBinding(ACCOUNT_A, expectedIds().threadId, 1),
      rejectStaleBinding: true,
      diagnosticWriteFailure: true,
    });

    const result = await invoke(harness);
    const payload = JSON.parse(resultText(result)) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    expect(payload.error?.code).toBe("operation_failed");
    expect(payload.error?.message).toContain("following thread may already exist");
    expect(payload.error?.details?.cause).toBe("synthetic stale binding revision");
    expect(payload.error?.details?.diagnosticStatus).toBe("write-failed");
    expect(payload.error?.details?.diagnosticWriteFailure).toBe("diagnostic_write_failed");
  });

  it("does not create another child or substitute account B when existing account A discovery fails", async () => {
    const ids = expectedIds();
    const harness = makeHarness({
      existingBinding: makeBinding(ACCOUNT_A, ids.threadId, 0),
      defaultConnection: ACCOUNT_B,
      discoveryFailure: true,
    });

    const result = await invoke(harness);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("synthetic discovery failure");
    expect(harness.engineCommands).toHaveLength(0);
    expect(harness.turnStartAttempts).toHaveLength(0);
    expect(harness.successfulTurnStarts).toHaveLength(0);
    expect(harness.selectionCalls).toBe(0);
    expect(harness.modelDiscoveryCalls).toHaveLength(1);
    expect(harness.modelDiscoveryCalls[0]?.connectionId).toBe(ACCOUNT_A);
  });

  it("does not use an admitted full-access plan after the caller is downgraded", async () => {
    const harness = makeHarness();
    expect((await invoke(harness)).isError).not.toBe(true);
    const dispatchedBeforeRetry = harness.engineCommands.length;
    const handler = await Effect.runPromise(
      makeCreateThreadHandler({
        ...harness.dependencies,
        requireThreadShell: () => Effect.succeed({ ...CALLER, runtimeMode: "approval-required" }),
      }),
    );
    const retry = await Effect.runPromise(handler(INPUT, CONTEXT));
    expect(retry.isError).toBe(true);
    expect(resultText(retry)).toContain("can no longer authorize");
    expect(harness.engineCommands).toHaveLength(dispatchedBeforeRetry);
  });

  it("does not use an admitted destination after the caller moves to another Space", async () => {
    const harness = makeHarness();
    expect((await invoke(harness)).isError).not.toBe(true);
    const dispatchedBeforeRetry = harness.engineCommands.length;
    const movedFolderId = FolderId.makeUnsafe("folder-moved");
    const movedSpaceId = SpaceId.makeUnsafe("space-moved");
    const handler = await Effect.runPromise(
      makeCreateThreadHandler({
        ...harness.dependencies,
        requireThreadShell: () => Effect.succeed({ ...CALLER, folderId: movedFolderId }),
        snapshotQuery: {
          ...harness.dependencies.snapshotQuery,
          getFolderShellById: (folderId) =>
            Effect.succeed(
              Option.some(
                folderId === movedFolderId
                  ? { ...FOLDER, id: movedFolderId, spaceId: movedSpaceId }
                  : FOLDER,
              ),
            ),
        },
      }),
    );
    const retry = await Effect.runPromise(handler(INPUT, CONTEXT));
    expect(retry.isError).toBe(true);
    expect(resultText(retry)).toContain("no longer in the caller Thread's Space");
    expect(harness.engineCommands).toHaveLength(dispatchedBeforeRetry);
  });

  it("does not replay or re-resolve defaults after the created child moves to another Space", async () => {
    const harness = makeHarness();
    expect((await invoke(harness)).isError).not.toBe(true);
    const ids = expectedIds();
    const movedFolderId = FolderId.makeUnsafe("child-moved-folder");
    const movedSpaceId = SpaceId.makeUnsafe("child-moved-space");
    const dispatchedBeforeRetry = harness.engineCommands.length;
    const selectionCallsBeforeRetry = harness.selectionCalls;
    const discoveryCallsBeforeRetry = harness.modelDiscoveryCalls.length;
    const handler = await Effect.runPromise(
      makeCreateThreadHandler({
        ...harness.dependencies,
        snapshotQuery: {
          ...harness.dependencies.snapshotQuery,
          getThreadShellById: (threadId) =>
            Effect.succeed(
              threadId === ids.threadId
                ? Option.some({ ...CALLER, id: ids.threadId, folderId: movedFolderId })
                : Option.none(),
            ),
          getFolderShellById: (folderId) =>
            Effect.succeed(
              Option.some(
                folderId === movedFolderId
                  ? { ...FOLDER, id: movedFolderId, spaceId: movedSpaceId }
                  : FOLDER,
              ),
            ),
        },
      }),
    );
    const retry = await Effect.runPromise(handler(INPUT, CONTEXT));
    expect(retry.isError).toBe(true);
    expect(resultText(retry)).toContain("created child Thread is no longer");
    expect(harness.engineCommands).toHaveLength(dispatchedBeforeRetry);
    expect(harness.selectionCalls).toBe(selectionCallsBeforeRetry);
    expect(harness.modelDiscoveryCalls).toHaveLength(discoveryCallsBeforeRetry);
  });
});

describe("L10 actual command fingerprint on creation retry", () => {
  it("preserves command content across clock advancement for the same request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-07T05:00:00Z"));
      const harness = makeHarness();
      await invoke(harness);
      vi.setSystemTime(new Date("2026-09-07T05:00:01Z"));
      await invoke(harness);
      const creates = threadCreateCommands(harness);
      expect(creates).toHaveLength(2);
      expect(creates[0]!.commandId).toBe(creates[1]!.commandId);
      expect(fingerprintOrchestrationCommand(creates[0]!)).toEqual(
        fingerprintOrchestrationCommand(creates[1]!),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

const sqliteAdmissionLayer = Layer.mergeAll(
  OrchestrationLayerLive,
  AgentGatewayCreationAdmissionRepositoryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

effectIt.layer(sqliteAdmissionLayer)("durable creation admission replay", (it) => {
  it.effect(
    "recovers partial acceptance after restart without adopting a changed account default",
    () =>
      Effect.gen(function* () {
        const admissions = yield* AgentGatewayCreationAdmissionRepository;
        const commandReceipts = yield* OrchestrationCommandReceiptRepository;
        const engine = yield* OrchestrationEngineService;
        const eventStore = yield* OrchestrationEventStore;
        const threadBindings = yield* ThreadProviderBindingRepository;
        const projections = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const base = makeHarness();
        let selectedConnection = ACCOUNT_A;
        let selectionCalls = 0;
        let failFirstTurn = true;

        yield* sql`
        INSERT INTO provider_installations (
          installation_id, harness_kind, version, platform, architecture, executable_path,
          artifact_source, artifact_url, artifact_sha256, adapter_version, protocol_version,
          lifecycle, installed_at, activated_at
        ) VALUES (${INSTALLATION_ID}, 'codex', '1', 'test', 'test', '/test/codex',
          'test', 'test', ${"a".repeat(64)}, '1', '1', 'active', ${NOW}, ${NOW})
      `;
        yield* sql`
        INSERT INTO provider_connections (
          connection_id, harness_kind, authentication_target_id, authentication_method_id,
          label, profile_ref, lifecycle, created_at, updated_at
        ) VALUES (${ACCOUNT_A}, 'codex', 'test', 'test', 'Account A', 'test-profile',
          'active', ${NOW}, ${NOW})
      `;

        yield* engine.dispatch({
          type: "space.create",
          commandId: CommandId.makeUnsafe("retry-space-create"),
          spaceId: SPACE_ID,
          name: "Retry",
          icon: "home",
          createdAt: NOW,
        });
        yield* engine.dispatch({
          type: "folder.create",
          commandId: CommandId.makeUnsafe("retry-folder-create"),
          folderId: FOLDER_ID,
          spaceId: SPACE_ID,
          title: FOLDER.title,
          workspaceRoot: null,
          defaultModelSelection: null,
          createdAt: NOW,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("retry-caller-create"),
          threadId: CALLER_THREAD_ID,
          folderId: FOLDER_ID,
          title: CALLER.title,
          modelSelection: TARGET,
          runtimeMode: "full-access",
          createdAt: NOW,
        });

        const dependencies: CreationDependencies = {
          ...base.dependencies,
          admissions,
          commandReceipts,
          providerTurnSelectionResolver: {
            ...base.dependencies.providerTurnSelectionResolver,
            resolveNewThreadConnection: () =>
              Effect.sync(() => {
                selectionCalls += 1;
                return selectedConnection;
              }),
          },
          snapshotQuery: projections,
          orchestrationEngine: engine,
          loadExistingBinding: (threadId) => threadBindings.getRuntimeBinding(threadId),
          requireThreadShell: (threadId) =>
            projections.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
              Effect.mapError((cause) => new ToolInputError(errorText(cause))),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new ToolInputError("missing test thread")),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          providerThreadSwitchCoordinator: {
            ...base.dependencies.providerThreadSwitchCoordinator,
            dispatchTurnStart: ({ command }) => {
              if (failFirstTurn) {
                failFirstTurn = false;
                return Effect.fail(
                  new ProviderThreadSwitchCoordinatorError({
                    detail: "synthetic partial acceptance",
                  }),
                );
              }
              return engine
                .dispatch(command, {
                  attachmentPrincipal: CONTEXT.attachmentPrincipal,
                  acceptedInitialProviderBinding: {
                    generation: {
                      id: ProviderNativeStateGenerationId.makeUnsafe(
                        `provider-initial-generation:${command.commandId}`,
                      ),
                      ownerThreadId: command.threadId,
                      harness: command.modelSelection!.provider,
                      adapterSchemaVersion: "managed-native-state-v1",
                      stateManifestJson: '{"initial":true}',
                      createdAt: command.createdAt,
                    },
                    threadId: command.threadId,
                    providerSessionId: null,
                    nativeStateLocatorJson: "null",
                    connectionId: command.connectionId!,
                    installationId: INSTALLATION_ID,
                    internalProviderId: null,
                    modelId: command.modelSelection!.model,
                    createdAt: command.createdAt,
                  },
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderThreadSwitchCoordinatorError({
                        detail: errorText(cause),
                        cause,
                      }),
                  ),
                );
            },
          },
        };

        const firstHandler = yield* makeCreateThreadHandler(dependencies);
        const first = yield* firstHandler(INPUT, CONTEXT);
        expect(first.isError).toBe(true);
        const ids = expectedIds();
        expect(
          Option.isSome(
            yield* commandReceipts.getByCommandId({ commandId: ids.threadCreateCommandId }),
          ),
        ).toBe(true);
        expect(
          Option.isNone(
            yield* commandReceipts.getByCommandId({ commandId: ids.turnStartCommandId }),
          ),
        ).toBe(true);
        expect(Option.isNone(yield* threadBindings.getRuntimeBinding(ids.threadId))).toBe(true);
        selectedConnection = ACCOUNT_B;

        // Reconstruct the coordinator as a server restart would; only SQLite state survives.
        const restartedHandler = yield* makeCreateThreadHandler(dependencies);
        const retry = yield* restartedHandler(INPUT, CONTEXT);
        expect(retry.isError, resultText(retry)).not.toBe(true);
        expect(resultText(retry)).toContain(String(ACCOUNT_A));
        expect(resultText(retry)).not.toContain(String(ACCOUNT_B));
        expect(selectionCalls).toBe(1);

        const createReceipt = yield* commandReceipts.getByCommandId({
          commandId: ids.threadCreateCommandId,
        });
        const turnReceipt = yield* commandReceipts.getByCommandId({
          commandId: ids.turnStartCommandId,
        });
        expect(Option.isSome(createReceipt)).toBe(true);
        expect(Option.isSome(turnReceipt)).toBe(true);
        const binding = yield* threadBindings.getRuntimeBinding(ids.threadId);
        expect(Option.getOrThrow(binding).connectionId).toBe(ACCOUNT_A);
        const highWater = yield* eventStore.getThreadHighWaterSequence(ids.threadId);
        const events = yield* eventStore.readThreadEvents({
          threadId: ids.threadId,
          throughSequenceInclusive: highWater,
          limit: 20,
        });
        expect(events.filter((event) => event.type === "thread.created")).toHaveLength(1);
        expect(events.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(
          1,
        );
        const stored = yield* admissions.get(ids.operationId);
        expect(Option.isSome(stored)).toBe(true);
        expect(Option.getOrThrow(stored).turnStartCommandJson).toContain(String(ACCOUNT_A));

        yield* sql`
        UPDATE provider_connections
        SET lifecycle = 'terminated', termination_reason = 'removed', terminated_at = ${NOW},
          updated_at = ${NOW}
        WHERE connection_id = ${ACCOUNT_A}
      `;

        const acceptedReplayHandler = yield* makeCreateThreadHandler({
          ...dependencies,
          providerDiscovery: {
            ...dependencies.providerDiscovery,
            listModels: () => Effect.die("accepted replay must not rediscover a removed account"),
          },
          providerThreadSwitchCoordinator: {
            ...dependencies.providerThreadSwitchCoordinator,
            dispatchTurnStart: () =>
              Effect.die("accepted replay must use the checked receipt path"),
          },
        });
        const acceptedReplay = yield* acceptedReplayHandler(INPUT, CONTEXT);
        expect(acceptedReplay.isError).not.toBe(true);
        expect(resultText(acceptedReplay)).toContain(String(ACCOUNT_A));
      }),
  );
});

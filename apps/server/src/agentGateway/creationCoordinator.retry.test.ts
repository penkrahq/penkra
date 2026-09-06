import {
  FolderId,
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
import { describe, expect, it } from "vitest";
import { ProviderValidationError } from "../provider/Errors.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderTurnSelectionResolverShape } from "../provider/Services/ProviderTurnSelectionResolver.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderThreadSwitchCoordinatorShape } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderThreadSwitchCoordinatorError } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { makeAgentCreationIds, stableGatewayDigest } from "./creationUtils.ts";
import { makeCreateThreadHandler, type GatewayCreationContext } from "./creationCoordinator.ts";
import type { AgentGatewayProviderAvailability } from "./targetResolver.ts";
import type { McpToolCallResult } from "./protocol.ts";

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
    getThreadShellById: () => Effect.die("unused snapshot method"),
    findSyntheticSubagentParentThread: () => Effect.die("unused snapshot method"),
    getThreadDetailById: () => Effect.die("unused snapshot method"),
    getThreadDetailForExportById: () => Effect.die("unused snapshot method"),
    getThreadDetailSnapshotById: () => Effect.die("unused snapshot method"),
    getThreadTurnsPage: () => Effect.die("unused snapshot method"),
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

  const dependencies: CreationDependencies = {
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
});

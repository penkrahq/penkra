import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CommandId,
  EventId,
  FolderId,
  MessageId,
  ProviderConnectionId,
  SpaceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@penkra/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  CodexAppServerManager,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
} from "../codexAppServerManager.ts";
import { ServerConfig } from "../config.ts";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProviderRuntimeEventRepository } from "../persistence/Services/ProviderRuntimeEvents.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderRuntimeIngestionService } from "../orchestration/Services/ProviderRuntimeIngestion.ts";
import { makeProviderCommandReactorLive } from "../orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderTurnSelectionResolver } from "./Services/ProviderTurnSelectionResolver.ts";
import { ProviderLaunchResolver } from "./Services/ProviderLaunchResolver.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { TextGeneration } from "../textGeneration/Services/TextGeneration.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEventDeliveryRepositoryLive } from "../persistence/Layers/OrchestrationEventDeliveries.ts";
import {
  OrchestrationEventDeliveryRepository,
  PROVIDER_COMMAND_REACTOR_CONSUMER,
} from "../persistence/Services/OrchestrationEventDeliveries.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { ProviderAdapterRegistry } from "./Services/ProviderAdapterRegistry.ts";
import { CodexAdapter } from "./Services/CodexAdapter.ts";
import { ProviderService } from "./Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory.ts";
import { makeDurableProviderServiceLive } from "./Layers/ProviderService.ts";
import { makeCodexAdapterLive } from "./Layers/CodexAdapter.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-adapter-boundary");
const TURN_ID = TurnId.makeUnsafe("turn-adapter-boundary");
const CONNECTION_ID = ProviderConnectionId.makeUnsafe("fixture-connection");
const MODEL_SELECTION: ModelSelection = { provider: "codex", model: "gpt-5-codex" };
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

type ControlledErrorNotification = {
  readonly eventId: string;
  readonly createdAt: string;
  readonly error: {
    readonly message: string;
    readonly codexErrorInfo?: string;
    readonly additionalDetails?: string;
  };
  readonly willRetry: boolean;
};

/**
 * This is a protocol fixture, not a native process. It subclasses the real
 * manager so CodexAdapter's EventEmitter -> runtime-event mapping remains in
 * the exercised path.
 */
class ControlledCodexManager extends CodexAppServerManager {
  readonly startInputs: CodexAppServerStartSessionInput[] = [];
  readonly sendInputs: CodexAppServerSendTurnInput[] = [];
  readonly steerInputs: CodexAppServerSendTurnInput[] = [];
  readonly nativeEmissionOrder: string[] = [];
  sendFailure: Error | undefined;
  sendFailureNotification: ControlledErrorNotification | undefined;
  steerFailure: Error | undefined;
  steerFailureNotification: ControlledErrorNotification | undefined = {
    eventId: "evt-steer-auth-failure-boundary",
    createdAt: "2026-09-07T10:01:02.000Z",
    error: {
      message: "Authentication required",
      additionalDetails: "controlled JSON-RPC authentication fixture during turn/steer",
    },
    willRetry: false,
  };
  private readonly controlledSessions = new Map<ThreadId, ProviderSession>();

  override async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    this.startInputs.push(input);
    const now = "2026-09-07T10:00:00.000Z";
    const session: ProviderSession = {
      provider: "codex",
      status: "ready",
      runtimeMode: input.runtimeMode,
      threadId: input.threadId,
      resumeCursor: { threadId: "native-fixture-thread" },
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
    };
    if (input.managedLaunch) {
      const rollout = path.join(
        input.managedLaunch.profileRoot,
        "codex-home",
        "sessions",
        "2026",
        "09",
        "07",
        "rollout-2026-09-07T10-00-00-native-fixture-thread.jsonl",
      );
      await mkdir(path.dirname(rollout), { recursive: true });
      await writeFile(rollout, "{}\n");
    }
    this.controlledSessions.set(input.threadId, session);
    return session;
  }

  override async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    this.sendInputs.push(input);
    if (this.sendFailureNotification) {
      this.emitNativeNotification(this.sendFailureNotification);
    }
    if (this.sendFailure) {
      throw this.sendFailure;
    }
    return { threadId: input.threadId, turnId: TURN_ID };
  }

  override async steerTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    this.steerInputs.push(input);
    if (this.steerFailure) {
      if (this.steerFailureNotification) {
        this.emitNativeNotification(this.steerFailureNotification);
      }
      throw this.steerFailure;
    }
    return { threadId: input.threadId, turnId: TURN_ID };
  }

  override async stopSession(threadId: ThreadId): Promise<void> {
    this.controlledSessions.delete(threadId);
  }

  override listSessions(): ProviderSession[] {
    return Array.from(this.controlledSessions.values());
  }

  override hasSession(threadId: ThreadId): boolean {
    return this.controlledSessions.has(threadId);
  }

  override async stopAll(): Promise<void> {
    this.controlledSessions.clear();
  }

  emitNativeNotification(input: {
    readonly eventId: string;
    readonly createdAt: string;
    readonly error: {
      readonly message: string;
      readonly codexErrorInfo?: string;
      readonly additionalDetails?: string;
    };
    readonly willRetry: boolean;
  }): void {
    this.nativeEmissionOrder.push(input.eventId);
    this.emit("event", {
      id: asEventId(input.eventId),
      kind: "notification",
      provider: "codex",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: input.createdAt,
      method: "error",
      payload: {
        error: input.error,
        willRetry: input.willRetry,
      },
    } satisfies ProviderEvent);
  }

  emitNativeSessionClosed(input: {
    readonly eventId: string;
    readonly createdAt: string;
    readonly message: string;
  }): void {
    this.nativeEmissionOrder.push(input.eventId);
    const session = this.controlledSessions.get(THREAD_ID);
    if (session !== undefined) {
      const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = session;
      this.controlledSessions.set(THREAD_ID, {
        ...sessionWithoutActiveTurn,
        status: "ready",
        updatedAt: input.createdAt,
      });
    }
    this.emit("event", {
      id: asEventId(input.eventId),
      kind: "session",
      provider: "codex",
      threadId: THREAD_ID,
      createdAt: input.createdAt,
      method: "session/closed",
      message: input.message,
    } satisfies ProviderEvent);
  }

  emitNativeTurnStarted(): void {
    this.nativeEmissionOrder.push("evt-turn-started-boundary");
    const session = this.controlledSessions.get(THREAD_ID);
    if (session !== undefined) {
      this.controlledSessions.set(THREAD_ID, {
        ...session,
        status: "running",
        activeTurnId: TURN_ID,
        updatedAt: "2026-09-07T10:00:01.000Z",
      });
    }
    this.emit("event", {
      id: asEventId("evt-turn-started-boundary"),
      kind: "notification",
      provider: "codex",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: "2026-09-07T10:00:01.000Z",
      method: "turn/started",
      payload: {},
    } satisfies ProviderEvent);
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for boundary fixture state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeProviderRuntime(
  dbPath: string,
  manager: ControlledCodexManager,
  initialize = true,
) {
  const fixtureProfileRoot = path.join(path.dirname(dbPath), "profile");
  const fixtureNativeStateRoot = path.join(path.dirname(dbPath), "native");
  const persistence = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
  const runtimeEventsLayer = ProviderRuntimeEventRepositoryLive.pipe(Layer.provide(persistence));
  const sessionRuntimeLayer = ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(persistence));
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(sessionRuntimeLayer));
  const adapterLayer = makeCodexAdapterLive({ manager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(directoryLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const registryLayer = Layer.effect(
    ProviderAdapterRegistry,
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      return {
        getByProvider: (provider: string) =>
          provider === "codex"
            ? Effect.succeed(adapter)
            : Effect.die(`unsupported fixture provider: ${provider}`),
        listProviders: () => Effect.succeed(["codex"] as const),
      } as typeof ProviderAdapterRegistry.Service;
    }),
  );
  const providerLayer = makeDurableProviderServiceLive({
    runtimeEventRetryBaseDelayMs: 1,
    runtimeEventRetryMaxDelayMs: 5,
  }).pipe(
    Layer.provide(registryLayer.pipe(Layer.provide(adapterLayer))),
    Layer.provide(directoryLayer),
    Layer.provideMerge(runtimeEventsLayer),
    Layer.provideMerge(AnalyticsService.layerTest),
    Layer.provideMerge(NodeServices.layer),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(persistence),
    Layer.provideMerge(NodeServices.layer),
  );
  const orchestrationEventsLayer = OrchestrationEventStoreLive.pipe(Layer.provide(persistence));
  const managedBindingLayer = Layer.mergeAll(
    Layer.succeed(ProviderTurnSelectionResolver, {
      resolveNewThreadConnection: () => Effect.succeed(CONNECTION_ID),
      resolveInitial: () =>
        Effect.succeed({
          threadId: THREAD_ID,
          harness: "codex",
          connectionId: CONNECTION_ID,
          connectionLabel: "Fixture",
          previousConnectionId: CONNECTION_ID,
          previousModelId: MODEL_SELECTION.model,
          installationId: "fixture-installation",
          internalProviderId: null,
          modelId: MODEL_SELECTION.model,
          modelLabel: MODEL_SELECTION.model,
          stateRevision: 0,
          bindingRevision: 0,
          changed: false,
        }),
      resolveExisting: (input: {
        readonly threadId: ThreadId;
        readonly modelSelection?: ModelSelection;
        readonly connectionId?: ProviderConnectionId | null;
        readonly bindingRevision?: number;
      }) =>
        Effect.succeed({
          threadId: input.threadId,
          harness: "codex",
          connectionId: input.connectionId ?? CONNECTION_ID,
          connectionLabel: "Fixture",
          previousConnectionId: CONNECTION_ID,
          previousModelId: input.modelSelection?.model ?? MODEL_SELECTION.model,
          installationId: "fixture-installation",
          internalProviderId: null,
          modelId: input.modelSelection?.model ?? MODEL_SELECTION.model,
          modelLabel: input.modelSelection?.model ?? MODEL_SELECTION.model,
          stateRevision: 0,
          bindingRevision: input.bindingRevision ?? 0,
          changed: false,
        }),
    } as never),
    Layer.succeed(ProviderLaunchResolver, {
      resolveProfile: () =>
        Effect.succeed({
          binaryPath: "/fixture/codex",
          isolationKey: "fixture-connection-generation-1",
          profileRoot: fixtureProfileRoot,
          nativeStateRoot: fixtureNativeStateRoot,
          connectionId: CONNECTION_ID,
          childEnvironment: (baseEnv: NodeJS.ProcessEnv) => ({ ...baseEnv }),
        }),
      resolve: () =>
        Effect.succeed({
          binaryPath: "/fixture/codex",
          isolationKey: "fixture-connection-generation-1",
          profileRoot: fixtureProfileRoot,
          nativeStateRoot: fixtureNativeStateRoot,
          connectionId: CONNECTION_ID,
          childEnvironment: (baseEnv: NodeJS.ProcessEnv) => ({ ...baseEnv }),
        }),
    } as never),
    Layer.succeed(ThreadProviderBindingRepository, {
      getHarnessState: (threadId: ThreadId) =>
        Effect.succeed(
          Option.some({
            threadId,
            harness: "codex",
            nativeStateGenerationId: "fixture-generation",
            providerSessionId: null,
            nativeStateLocatorJson: "null",
            lastVerifiedResumeAt: null,
            revision: 0,
            createdAt: "2026-09-07T10:00:00.000Z",
            updatedAt: "2026-09-07T10:00:00.000Z",
          }),
        ),
    } as never),
  );
  const switchCoordinatorLayer = Layer.effect(
    ProviderThreadSwitchCoordinator,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      return {
        dispatchTurnStart: ({ command }: { readonly command: unknown }) =>
          engine.dispatch(command as never),
        recoverOpen: Effect.void,
      } as never;
    }),
  ).pipe(
    Layer.provide(orchestrationLayer),
    Layer.provideMerge(persistence),
    Layer.provideMerge(NodeServices.layer),
  );
  const ingestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(runtimeEventsLayer),
    Layer.provide(persistence),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );
  const reactorLayer = makeProviderCommandReactorLive({
    queuedTurnRecoveryInterval: Duration.millis(10),
  }).pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(managedBindingLayer),
    Layer.provideMerge(switchCoordinatorLayer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(
      Layer.succeed(TextGeneration, {
        generateThreadTitle: () => Effect.fail(new Error("fixture title generation disabled")),
      } as never),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(OrchestrationEventDeliveryRepositoryLive),
    Layer.provideMerge(persistence),
  );
  const runtime = ManagedRuntime.make(
    Layer.merge(
      Layer.merge(ingestionLayer, reactorLayer),
      Layer.merge(orchestrationEventsLayer, NodeServices.layer),
    ),
  );
  const provider = await runtime.runPromise(Effect.service(ProviderService));
  const events = await runtime.runPromise(Effect.service(ProviderRuntimeEventRepository));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projection = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
  const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
  const orchestrationEvents = await runtime.runPromise(Effect.service(OrchestrationEventStore));
  const deliveries = await runtime.runPromise(Effect.service(OrchestrationEventDeliveryRepository));
  if (!initialize) {
    return {
      runtime,
      provider,
      events,
      engine,
      projection,
      ingestion,
      reactor,
      orchestrationEvents,
      deliveries,
      workerScope: undefined,
    };
  }
  const now = "2026-09-07T10:00:00.000Z";
  await runtime.runPromise(
    engine.dispatch({
      type: "space.create",
      commandId: CommandId.makeUnsafe("cmd-boundary-space"),
      spaceId: SpaceId.makeUnsafe("space-boundary"),
      name: "Boundary",
      icon: "home",
      createdAt: now,
    }),
  );
  await runtime.runPromise(
    engine.dispatch({
      type: "folder.create",
      commandId: CommandId.makeUnsafe("cmd-boundary-folder"),
      folderId: FolderId.makeUnsafe("folder-boundary"),
      title: "Boundary",
      workspaceRoot: null,
      spaceId: SpaceId.makeUnsafe("space-boundary"),
      defaultModelSelection: MODEL_SELECTION,
      createdAt: now,
    }),
  );
  await runtime.runPromise(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-boundary-thread"),
      threadId: THREAD_ID,
      folderId: FolderId.makeUnsafe("folder-boundary"),
      title: "Adapter boundary",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      workingDirectory: "/tmp/provider-boundary",
      createdAt: now,
    }),
  );
  await runtime.runPromise(
    provider.startSession(THREAD_ID, {
      provider: "codex",
      threadId: THREAD_ID,
      cwd: "/tmp/provider-boundary",
      runtimeMode: "full-access",
      managedLaunch: {
        binaryPath: "/fixture/codex",
        isolationKey: "fixture-connection-generation-1",
        profileRoot: fixtureProfileRoot,
        nativeStateRoot: fixtureNativeStateRoot,
        connectionId: CONNECTION_ID,
        childEnvironment: (baseEnv) => ({ ...baseEnv }),
      },
    }),
  );
  await runtime.runPromise(
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("cmd-boundary-session-ready"),
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TURN_ID,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    }),
  );
  const workerScope = await Effect.runPromise(Scope.make("sequential"));
  await runtime.runPromise(ingestion.start.pipe(Scope.provide(workerScope)));
  await runtime.runPromise(reactor.start.pipe(Scope.provide(workerScope)));
  return {
    runtime,
    provider,
    events,
    engine,
    projection,
    ingestion,
    reactor,
    orchestrationEvents,
    deliveries,
    workerScope,
  };
}

type BoundaryHarness = Awaited<ReturnType<typeof makeProviderRuntime>>;

async function disposeBoundaryHarness(harness: BoundaryHarness): Promise<ReadonlyArray<unknown>> {
  const failures: unknown[] = [];
  try {
    if (harness.workerScope !== undefined) {
      await Effect.runPromise(Scope.close(harness.workerScope, Exit.void));
    }
  } catch (cause) {
    failures.push(cause);
  }
  try {
    await harness.runtime.runPromise(harness.provider.closeRuntimeEvents);
  } catch (cause) {
    failures.push(cause);
  }
  try {
    await harness.runtime.dispose();
  } catch (cause) {
    failures.push(cause);
  }
  return failures;
}

async function projectedThread(harness: BoundaryHarness) {
  const snapshot = await harness.runtime.runPromise(harness.projection.getSnapshot());
  return snapshot.threads.find((thread) => thread.id === THREAD_ID);
}

async function persistedBoundaryTrace(
  harness: BoundaryHarness,
  messageId: MessageId,
): Promise<{
  readonly intentEvent:
    | {
        readonly sequence: number;
        readonly type: string;
        readonly payload: Record<string, unknown>;
      }
    | undefined;
  readonly commandDelivery: unknown;
  readonly blockingDelivery: unknown;
  readonly pendingStartOutcome: unknown;
  readonly latestTurn: unknown;
  readonly messageDelivery: unknown;
  readonly eventTypes: ReadonlyArray<
    Readonly<{ readonly sequence: number; readonly type: string }>
  >;
}> {
  const through = await harness.runtime.runPromise(
    harness.orchestrationEvents.getThreadHighWaterSequence(THREAD_ID),
  );
  const events = await harness.runtime.runPromise(
    harness.orchestrationEvents.readThreadEvents({
      threadId: THREAD_ID,
      throughSequenceInclusive: through,
      limit: 200,
    }),
  );
  const intentEvent = events
    .toReversed()
    .find(
      (event) =>
        event.type === "thread.turn-start-requested" &&
        (event.payload as { readonly messageId?: string }).messageId === messageId,
    );
  const commandDelivery =
    intentEvent === undefined
      ? Option.none()
      : await harness.runtime.runPromise(
          harness.deliveries.getDelivery({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: intentEvent.sequence,
          }),
        );
  const blockingDelivery = await harness.runtime.runPromise(
    harness.deliveries.firstBlockingDeliveryForThread({
      consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
      threadId: THREAD_ID,
    }),
  );
  const pendingStartOutcome = await harness.runtime.runPromise(
    harness.projection.getPendingStartOutcome({
      threadId: THREAD_ID,
      messageId,
      minimumSequence: 0,
    }),
  );
  const thread = await projectedThread(harness);
  const message = thread?.messages.find((entry) => entry.id === messageId);
  return {
    intentEvent:
      intentEvent === undefined
        ? undefined
        : {
            sequence: intentEvent.sequence,
            type: intentEvent.type,
            payload: intentEvent.payload as Record<string, unknown>,
          },
    commandDelivery: Option.isSome(commandDelivery) ? commandDelivery.value : null,
    blockingDelivery: Option.isSome(blockingDelivery) ? blockingDelivery.value : null,
    pendingStartOutcome,
    latestTurn: thread?.latestTurn ?? null,
    messageDelivery: message?.delivery ?? null,
    eventTypes: events.toReversed().map((event) => ({
      sequence: event.sequence,
      type: event.type,
    })),
  };
}

async function establishRunningPredecessorAndQueuedSuccessor(
  harness: BoundaryHarness,
  manager: ControlledCodexManager,
  input: {
    readonly predecessorMessageId: MessageId;
    readonly predecessorText: string;
    readonly successorMessageId: MessageId;
    readonly successorText: string;
    readonly commandPrefix: string;
  },
): Promise<void> {
  await harness.runtime.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.start",
      connectionId: CONNECTION_ID,
      bindingRevision: 0,
      commandId: CommandId.makeUnsafe(`${input.commandPrefix}-predecessor`),
      threadId: THREAD_ID,
      message: {
        messageId: input.predecessorMessageId,
        role: "user",
        text: input.predecessorText,
        attachments: [],
      },
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      createdAt: "2026-09-07T10:02:00.000Z",
    }),
  );
  await waitFor(async () => manager.sendInputs.length === 1);
  manager.emitNativeTurnStarted();
  await waitFor(async () => (await projectedThread(harness))?.session?.status === "running");

  await harness.runtime.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.start",
      connectionId: CONNECTION_ID,
      bindingRevision: 0,
      commandId: CommandId.makeUnsafe(`${input.commandPrefix}-successor`),
      threadId: THREAD_ID,
      message: {
        messageId: input.successorMessageId,
        role: "user",
        text: input.successorText,
        attachments: [],
      },
      dispatchMode: "queue",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      createdAt: "2026-09-07T10:02:01.000Z",
    }),
  );
  await waitFor(
    async () =>
      (await projectedThread(harness))?.messages.find(
        (message) => message.id === input.successorMessageId,
      )?.delivery?.state === "queued",
  );
}

async function closeBoundaryHarnesses(
  fixtureRoot: string,
  harnesses: ReadonlyArray<BoundaryHarness | undefined>,
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  for (const harness of harnesses) {
    if (harness) cleanupFailures.push(...(await disposeBoundaryHarness(harness)));
  }
  try {
    await rm(fixtureRoot, { recursive: true, force: true });
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `boundary fixture teardown failures: ${cleanupFailures.map(String).join(" | ")}`,
    );
  }
}

describe("CodexAdapter -> ProviderService failure boundary", () => {
  it("journals the adapter-normalized terminal contract and retains it after offline restart", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-boundary-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    let first: Awaited<ReturnType<typeof makeProviderRuntime>> | undefined;
    let second: Awaited<ReturnType<typeof makeProviderRuntime>> | undefined;
    try {
      first = await makeProviderRuntime(dbPath, manager);
      await waitFor(async () => manager.listenerCount("event") === 1);
      manager.emitNativeTurnStarted();
      manager.emitNativeNotification({
        eventId: "evt-auth-failure-boundary",
        createdAt: "2026-09-07T10:00:02.000Z",
        error: {
          message: "Authentication required",
          additionalDetails: "controlled JSON-RPC authentication fixture",
        },
        willRetry: false,
      });
      manager.emitNativeNotification({
        eventId: "evt-usage-failure-boundary",
        createdAt: "2026-09-07T10:00:03.000Z",
        error: {
          message: "usage limit reached",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: "Provider-supplied diagnostic text.",
        },
        willRetry: false,
      });
      await waitFor(
        async () => (await first!.runtime.runPromise(first!.events.getHighWaterSequence)) === 3,
      );
      await first.runtime.runPromise(first.ingestion.drain);
      const projected = await first.runtime.runPromise(first.projection.getSnapshot());
      const projectedThread = projected.threads.find((thread) => thread.id === THREAD_ID);
      expect(projectedThread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: TURN_ID,
        lastError: "usage limit reached",
      });
      expect(manager.nativeEmissionOrder).toEqual([
        "evt-turn-started-boundary",
        "evt-auth-failure-boundary",
        "evt-usage-failure-boundary",
      ]);

      const rows = await first.runtime.runPromise(
        first.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: 3,
          limit: 10,
        }),
      );
      // readThreadEvents is intentionally newest-first; reverse it before
      // making causal sequence assertions.
      expect(rows.map((row) => row.sequence)).toEqual([3, 2, 1]);
      const rowsAscending = rows.toReversed();
      expect(rowsAscending.map((row) => row.sequence)).toEqual([1, 2, 3]);
      const events = rowsAscending.map((row) => row.event);
      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "runtime.error",
        "runtime.error",
      ]);
      expect(events.map((event) => event.createdAt)).toEqual([
        "2026-09-07T10:00:01.000Z",
        "2026-09-07T10:00:02.000Z",
        "2026-09-07T10:00:03.000Z",
      ]);
      const authEvent = events.find((event) => event.eventId === "evt-auth-failure-boundary");
      const usageEvent = events.find((event) => event.eventId === "evt-usage-failure-boundary");
      expect(authEvent?.payload).toEqual({
        message: "Authentication required",
        class: "provider_error",
        detail: {
          error: {
            message: "Authentication required",
            additionalDetails: "controlled JSON-RPC authentication fixture",
          },
          willRetry: false,
        },
      });
      expect(usageEvent?.payload).toEqual({
        message: "usage limit reached",
        class: "provider_error",
        detail: {
          error: {
            message: "usage limit reached",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: "Provider-supplied diagnostic text.",
          },
          willRetry: false,
        },
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.startInputs[0]?.managedLaunch?.connectionId).toBe(CONNECTION_ID);
      expect(manager.sendInputs).toHaveLength(0);
      expect(manager.steerInputs).toHaveLength(0);

      const firstCleanupFailures = await disposeBoundaryHarness(first);
      first = undefined;
      if (firstCleanupFailures.length > 0) {
        throw new Error(
          `boundary fixture teardown failures: ${firstCleanupFailures.map(String).join(" | ")}`,
        );
      }

      second = await makeProviderRuntime(dbPath, manager, false);
      const retained = await second.runtime.runPromise(
        second.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: 3,
          limit: 10,
        }),
      );
      const retainedAscending = retained.toReversed();
      expect(retainedAscending.map((row) => row.sequence)).toEqual([1, 2, 3]);
      expect(retainedAscending.map((row) => row.event.eventId)).toEqual([
        "evt-turn-started-boundary",
        "evt-auth-failure-boundary",
        "evt-usage-failure-boundary",
      ]);
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(0);
      expect(manager.steerInputs).toHaveLength(0);
    } finally {
      const cleanupFailures: unknown[] = [];
      if (first) cleanupFailures.push(...(await disposeBoundaryHarness(first)));
      if (second) cleanupFailures.push(...(await disposeBoundaryHarness(second)));
      try {
        await rm(fixtureRoot, { recursive: true, force: true });
      } catch (cause) {
        cleanupFailures.push(cause);
      }
      if (cleanupFailures.length > 0) {
        throw new Error(
          `boundary fixture teardown failures: ${cleanupFailures.map(String).join(" | ")}`,
        );
      }
    }
  });

  it("routes the exact queued message through native steer and retains auth failure state", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-steer-boundary-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    let harness: Awaited<ReturnType<typeof makeProviderRuntime>> | undefined;
    let restarted: Awaited<ReturnType<typeof makeProviderRuntime>> | undefined;
    const firstMessageId = MessageId.makeUnsafe("message-steer-source");
    const queuedMessageId = MessageId.makeUnsafe("message-steer-queued");
    try {
      harness = await makeProviderRuntime(dbPath, manager);
      const now = "2026-09-07T10:01:00.000Z";
      await harness.runtime.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          connectionId: CONNECTION_ID,
          bindingRevision: 0,
          commandId: CommandId.makeUnsafe("cmd-steer-source"),
          threadId: THREAD_ID,
          message: {
            messageId: firstMessageId,
            role: "user",
            text: "start the native turn",
            attachments: [],
          },
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          createdAt: now,
        }),
      );
      await waitFor(async () => manager.sendInputs.length === 1);
      manager.emitNativeTurnStarted();
      await waitFor(
        async () => (await harness!.runtime.runPromise(harness!.events.getHighWaterSequence)) >= 1,
      );
      const startedRows = await harness.runtime.runPromise(
        harness.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: 1,
          limit: 1,
        }),
      );
      expect(startedRows[0]?.sequence).toBe(1);
      expect(startedRows[0]?.event.type).toBe("turn.started");
      await waitFor(async () => {
        const snapshot = await harness!.runtime.runPromise(harness!.projection.getSnapshot());
        return (
          snapshot.threads.find((thread) => thread.id === THREAD_ID)?.session?.status === "running"
        );
      });

      await harness.runtime.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          connectionId: CONNECTION_ID,
          bindingRevision: 0,
          commandId: CommandId.makeUnsafe("cmd-steer-queued"),
          threadId: THREAD_ID,
          message: {
            messageId: queuedMessageId,
            role: "user",
            text: "steer this exact queued message",
            attachments: [],
          },
          dispatchMode: "queue",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          createdAt: "2026-09-07T10:01:01.000Z",
        }),
      );
      await waitFor(async () => {
        const snapshot = await harness!.runtime.runPromise(harness!.projection.getSnapshot());
        return (
          snapshot.threads
            .find((thread) => thread.id === THREAD_ID)
            ?.messages.find((message) => message.id === queuedMessageId)?.delivery?.state ===
          "queued"
        );
      });

      manager.steerFailure = new Error("turn/steer failed: Authentication required");
      await harness.runtime.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer-queued",
          commandId: CommandId.makeUnsafe("cmd-steer-queued-auth-failure"),
          threadId: THREAD_ID,
          messageId: queuedMessageId,
          createdAt: "2026-09-07T10:01:02.000Z",
        }),
      );
      await waitFor(async () => manager.steerInputs.length === 1);
      await harness.runtime.runPromise(harness.reactor.drain);
      await harness.runtime.runPromise(harness.ingestion.drain);
      const authTrace = await persistedBoundaryTrace(harness, queuedMessageId);
      expect(authTrace.commandDelivery).toMatchObject({
        eventSequence: 13,
        state: "uncertain",
        attemptCount: 1,
      });
      expect(authTrace.messageDelivery).toMatchObject({
        state: "failed",
        queued: false,
        sequence: 14,
      });
      expect(authTrace.pendingStartOutcome).toMatchObject({ outcome: "unknown" });
      const steerRows = await harness.runtime.runPromise(
        harness.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: 2,
          limit: 10,
        }),
      );
      const steerError = steerRows
        .toReversed()
        .find((row) => row.event.eventId === "evt-steer-auth-failure-boundary");
      expect(steerError?.sequence).toBe(2);
      expect(steerError?.event.type).toBe("runtime.error");
      expect(steerError?.event.payload).toEqual({
        message: "Authentication required",
        class: "provider_error",
        detail: {
          error: {
            message: "Authentication required",
            additionalDetails: "controlled JSON-RPC authentication fixture during turn/steer",
          },
          willRetry: false,
        },
      });

      const afterFailure = await harness.runtime.runPromise(harness.projection.getSnapshot());
      const failedMessage = afterFailure.threads
        .find((thread) => thread.id === THREAD_ID)
        ?.messages.find((message) => message.id === queuedMessageId);
      expect(failedMessage?.text).toBe("steer this exact queued message");
      expect(failedMessage?.delivery?.state).toBe("failed");
      expect(failedMessage?.delivery?.queued).toBe(false);
      expect(afterFailure.threads.find((thread) => thread.id === THREAD_ID)?.session).toMatchObject(
        {
          threadId: THREAD_ID,
          status: "error",
          activeTurnId: TURN_ID,
        },
      );
      expect(
        afterFailure.threads.find((thread) => thread.id === THREAD_ID)?.session?.lastError,
      ).toContain("Authentication required");
      expect(manager.startInputs[0]?.managedLaunch?.connectionId).toBe(CONNECTION_ID);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.steerInputs).toHaveLength(1);
      expect(manager.steerInputs[0]?.threadId).toBe(THREAD_ID);
      expect(manager.steerInputs[0]?.input).toBe("steer this exact queued message");

      const harnessCleanupFailures = await disposeBoundaryHarness(harness);
      harness = undefined;
      if (harnessCleanupFailures.length > 0) {
        throw new Error(
          `boundary fixture teardown failures: ${harnessCleanupFailures.map(String).join(" | ")}`,
        );
      }
      restarted = await makeProviderRuntime(dbPath, manager, false);
      const retained = await restarted.runtime.runPromise(restarted.projection.getSnapshot());
      const retainedMessage = retained.threads
        .find((thread) => thread.id === THREAD_ID)
        ?.messages.find((message) => message.id === queuedMessageId);
      expect(retainedMessage?.delivery?.state).toBe("failed");
      expect(retainedMessage?.delivery?.queued).toBe(false);
      expect(retained.threads.find((thread) => thread.id === THREAD_ID)?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: TURN_ID,
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.steerInputs).toHaveLength(1);
    } finally {
      const cleanupFailures: unknown[] = [];
      if (harness) cleanupFailures.push(...(await disposeBoundaryHarness(harness)));
      if (restarted) cleanupFailures.push(...(await disposeBoundaryHarness(restarted)));
      try {
        await rm(fixtureRoot, { recursive: true, force: true });
      } catch (cause) {
        cleanupFailures.push(cause);
      }
      if (cleanupFailures.length > 0) {
        throw new Error(
          `boundary fixture teardown failures: ${cleanupFailures.map(String).join(" | ")}`,
        );
      }
    }
  });

  it("P1: retains a pre-acceptance structured provider failure across offline restart", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-p1-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    manager.sendFailureNotification = {
      eventId: "evt-pre-acceptance-usage-limit",
      createdAt: "2026-09-07T10:02:02.000Z",
      error: {
        message: "usage limit reached",
        codexErrorInfo: "usageLimitExceeded",
        additionalDetails: "controlled JSON-RPC pre-acceptance fixture",
      },
      willRetry: false,
    };
    manager.sendFailure = new Error("turn/start failed: usage limit reached");
    let harness: BoundaryHarness | undefined;
    let restarted: BoundaryHarness | undefined;
    const messageId = MessageId.makeUnsafe("message-p1-pre-acceptance");
    try {
      harness = await makeProviderRuntime(dbPath, manager);
      await harness.runtime.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          connectionId: CONNECTION_ID,
          bindingRevision: 0,
          commandId: CommandId.makeUnsafe("cmd-p1-pre-acceptance"),
          threadId: THREAD_ID,
          message: {
            messageId,
            role: "user",
            text: "P1 pre-acceptance usage fixture",
            attachments: [],
          },
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          createdAt: "2026-09-07T10:02:00.000Z",
        }),
      );
      await waitFor(async () => manager.sendInputs.length === 1);
      await harness.runtime.runPromise(harness.reactor.drain);
      await harness.runtime.runPromise(harness.ingestion.drain);
      const p1Trace = await persistedBoundaryTrace(harness, messageId);
      expect(p1Trace.commandDelivery).toMatchObject({
        eventSequence: 6,
        state: "uncertain",
        attemptCount: 1,
      });
      expect(p1Trace.messageDelivery).toMatchObject({
        state: "failed",
        queued: false,
        sequence: 7,
      });
      expect(p1Trace.pendingStartOutcome).toMatchObject({
        outcome: "pending",
        turnId: "turn:cmd-p1-pre-acceptance",
      });
      expect(p1Trace.latestTurn).toMatchObject({
        turnId: "turn:cmd-p1-pre-acceptance",
        state: "running",
        startedAt: null,
      });

      const snapshot = await harness.runtime.runPromise(harness.projection.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      const message = thread?.messages.find((entry) => entry.id === messageId);
      expect(message?.text).toBe("P1 pre-acceptance usage fixture");
      expect(message?.delivery?.state).toBe("failed");
      expect(message?.delivery?.queued).toBe(false);
      expect(thread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: TURN_ID,
      });
      expect(thread?.session?.lastError).toContain("usage limit reached");
      const highWater = await harness.runtime.runPromise(harness.events.getHighWaterSequence);
      expect(highWater).toBe(1);
      const rows = await harness.runtime.runPromise(
        harness.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: highWater,
          limit: 10,
        }),
      );
      expect(rows.map((row) => row.sequence)).toEqual([1]);
      expect(rows[0]?.event).toMatchObject({
        type: "runtime.error",
        eventId: "evt-pre-acceptance-usage-limit",
        payload: {
          message: "usage limit reached",
          class: "provider_error",
          detail: {
            error: {
              message: "usage limit reached",
              codexErrorInfo: "usageLimitExceeded",
              additionalDetails: "controlled JSON-RPC pre-acceptance fixture",
            },
            willRetry: false,
          },
        },
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.startInputs[0]?.managedLaunch?.connectionId).toBe(CONNECTION_ID);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.sendInputs[0]?.threadId).toBe(THREAD_ID);
      expect(manager.sendInputs[0]?.input).toBe("P1 pre-acceptance usage fixture");
      expect(manager.steerInputs).toHaveLength(0);

      const cleanupFailures = await disposeBoundaryHarness(harness);
      harness = undefined;
      expect(cleanupFailures).toEqual([]);
      restarted = await makeProviderRuntime(dbPath, manager, false);
      const retained = await restarted.runtime.runPromise(restarted.projection.getSnapshot());
      const retainedTrace = await persistedBoundaryTrace(restarted, messageId);
      const retainedThread = retained.threads.find((entry) => entry.id === THREAD_ID);
      expect(retainedThread?.messages.find((entry) => entry.id === messageId)).toMatchObject({
        id: messageId,
        text: "P1 pre-acceptance usage fixture",
        delivery: { state: "failed", queued: false },
      });
      expect(retainedThread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: TURN_ID,
      });
      expect(retainedTrace.commandDelivery).toMatchObject({
        eventSequence: 6,
        state: "uncertain",
        attemptCount: 1,
      });
      expect(retainedTrace.pendingStartOutcome).toMatchObject({
        outcome: "pending",
        turnId: "turn:cmd-p1-pre-acceptance",
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.steerInputs).toHaveLength(0);
    } finally {
      await closeBoundaryHarnesses(fixtureRoot, [harness, restarted]);
    }
  });

  it("P2: characterizes a queued successor after an adapter-mapped usage-limit terminal", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-p2-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    let harness: BoundaryHarness | undefined;
    let restarted: BoundaryHarness | undefined;
    const predecessorMessageId = MessageId.makeUnsafe("message-p2-predecessor");
    const successorMessageId = MessageId.makeUnsafe("message-p2-successor");
    try {
      harness = await makeProviderRuntime(dbPath, manager);
      await establishRunningPredecessorAndQueuedSuccessor(harness, manager, {
        predecessorMessageId,
        predecessorText: "P2 predecessor",
        successorMessageId,
        successorText: "P2 exact queued successor",
        commandPrefix: "cmd-p2",
      });
      manager.emitNativeNotification({
        eventId: "evt-p2-usage-limit",
        createdAt: "2026-09-07T10:02:02.000Z",
        error: {
          message: "usage limit reached",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: "controlled JSON-RPC queued successor fixture",
        },
        willRetry: false,
      });
      await waitFor(
        async () => (await harness!.runtime.runPromise(harness!.events.getHighWaterSequence)) === 2,
      );
      await harness.runtime.runPromise(harness.reactor.drain);
      await harness.runtime.runPromise(harness.ingestion.drain);
      const p2Trace = await persistedBoundaryTrace(harness, successorMessageId);
      const p2PredecessorTrace = await persistedBoundaryTrace(harness, predecessorMessageId);
      expect(p2Trace.intentEvent).toBeUndefined();
      expect(p2Trace.commandDelivery).toBeNull();
      expect(p2Trace.pendingStartOutcome).toMatchObject({
        outcome: "pending",
        turnId: "turn:cmd-p2-successor",
      });
      expect(p2Trace.messageDelivery).toMatchObject({
        state: "queued",
        queued: true,
        sequence: 9,
      });
      expect(p2PredecessorTrace.commandDelivery).toMatchObject({
        eventSequence: 6,
        state: "succeeded",
        attemptCount: 1,
      });
      expect(p2PredecessorTrace.pendingStartOutcome).toMatchObject({ outcome: "accepted" });

      const snapshot = await harness.runtime.runPromise(harness.projection.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.messages.find((entry) => entry.id === predecessorMessageId)).toMatchObject({
        id: predecessorMessageId,
        text: "P2 predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(thread?.messages.find((entry) => entry.id === successorMessageId)).toMatchObject({
        id: successorMessageId,
        text: "P2 exact queued successor",
      });
      expect(
        thread?.messages.find((entry) => entry.id === successorMessageId)?.delivery,
      ).toMatchObject({
        state: "queued",
        queued: true,
      });
      expect(thread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: TURN_ID,
      });
      expect(thread?.session?.lastError).toBe("usage limit reached");
      const rows = await harness.runtime.runPromise(
        harness.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: 2,
          limit: 10,
        }),
      );
      const ascending = rows.toReversed();
      expect(ascending.map((row) => row.sequence)).toEqual([1, 2]);
      expect(ascending.map((row) => row.event.type)).toEqual(["turn.started", "runtime.error"]);
      expect(ascending[1]?.event).toMatchObject({
        eventId: "evt-p2-usage-limit",
        createdAt: "2026-09-07T10:02:02.000Z",
        payload: {
          detail: {
            error: { codexErrorInfo: "usageLimitExceeded" },
            willRetry: false,
          },
        },
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.sendInputs[0]?.input).toBe("P2 predecessor");
      expect(manager.steerInputs).toHaveLength(0);
      expect(manager.sendInputs.every((input) => input.threadId === THREAD_ID)).toBe(true);

      const cleanupFailures = await disposeBoundaryHarness(harness);
      harness = undefined;
      expect(cleanupFailures).toEqual([]);
      restarted = await makeProviderRuntime(dbPath, manager, false);
      const retained = await restarted.runtime.runPromise(restarted.projection.getSnapshot());
      const retainedThread = retained.threads.find((entry) => entry.id === THREAD_ID);
      expect(
        retainedThread?.messages.find((entry) => entry.id === predecessorMessageId),
      ).toMatchObject({
        text: "P2 predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(
        retainedThread?.messages.find((entry) => entry.id === successorMessageId),
      ).toMatchObject({
        text: "P2 exact queued successor",
        delivery: { state: "queued", queued: true },
      });
      expect(retainedThread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: TURN_ID,
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.steerInputs).toHaveLength(0);
    } finally {
      await closeBoundaryHarnesses(fixtureRoot, [harness, restarted]);
    }
  });

  it("P3: retains exact queued-successor ownership after adapter-mapped session closure and restart", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-p3-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    let harness: BoundaryHarness | undefined;
    let restarted: BoundaryHarness | undefined;
    const predecessorMessageId = MessageId.makeUnsafe("message-p3-predecessor");
    const successorMessageId = MessageId.makeUnsafe("message-p3-successor");
    try {
      harness = await makeProviderRuntime(dbPath, manager);
      await establishRunningPredecessorAndQueuedSuccessor(harness, manager, {
        predecessorMessageId,
        predecessorText: "P3 predecessor",
        successorMessageId,
        successorText: "P3 exact successor after session closure",
        commandPrefix: "cmd-p3",
      });
      manager.emitNativeSessionClosed({
        eventId: "evt-p3-session-closed",
        createdAt: "2026-09-07T10:03:02.000Z",
        message: "controlled provider session closed",
      });
      await waitFor(
        async () => (await harness!.runtime.runPromise(harness!.events.getHighWaterSequence)) === 2,
      );
      await harness.runtime.runPromise(harness.reactor.drain);
      await harness.runtime.runPromise(harness.ingestion.drain);
      const p3Trace = await persistedBoundaryTrace(harness, successorMessageId);
      expect(p3Trace.commandDelivery).toMatchObject({
        eventSequence: 11,
        state: "succeeded",
        attemptCount: 1,
      });
      expect(p3Trace.pendingStartOutcome).toMatchObject({
        outcome: "accepted",
        turnId: "turn:cmd-p3-successor",
      });
      expect(p3Trace.messageDelivery).toMatchObject({
        state: "accepted",
        queued: true,
        sequence: 13,
      });
      expect(p3Trace.latestTurn).toMatchObject({
        turnId: "turn:cmd-p3-successor",
        providerTurnId: TURN_ID,
        state: "running",
        startedAt: null,
      });

      const snapshot = await harness.runtime.runPromise(harness.projection.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.messages.find((entry) => entry.id === predecessorMessageId)).toMatchObject({
        id: predecessorMessageId,
        text: "P3 predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(thread?.messages.find((entry) => entry.id === successorMessageId)).toMatchObject({
        id: successorMessageId,
        text: "P3 exact successor after session closure",
        delivery: { state: "accepted", queued: true },
      });
      expect(thread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "stopped",
        activeTurnId: null,
      });
      const rows = await harness.runtime.runPromise(
        harness.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: 2,
          limit: 10,
        }),
      );
      const ascending = rows.toReversed();
      expect(ascending.map((row) => row.sequence)).toEqual([1, 2]);
      expect(ascending.map((row) => row.event.type)).toEqual(["turn.started", "session.exited"]);
      expect(ascending[1]?.event).toMatchObject({
        eventId: "evt-p3-session-closed",
        createdAt: "2026-09-07T10:03:02.000Z",
        payload: {
          exitKind: "graceful",
          reason: "controlled provider session closed",
        },
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(2);
      expect(manager.sendInputs[0]?.input).toBe("P3 predecessor");
      expect(manager.sendInputs[1]?.input).toBe("P3 exact successor after session closure");
      expect(manager.sendInputs.every((input) => input.threadId === THREAD_ID)).toBe(true);
      expect(manager.steerInputs).toHaveLength(0);

      const cleanupFailures = await disposeBoundaryHarness(harness);
      harness = undefined;
      expect(cleanupFailures).toEqual([]);
      restarted = await makeProviderRuntime(dbPath, manager, false);
      const retained = await restarted.runtime.runPromise(restarted.projection.getSnapshot());
      const retainedThread = retained.threads.find((entry) => entry.id === THREAD_ID);
      expect(
        retainedThread?.messages.find((entry) => entry.id === predecessorMessageId),
      ).toMatchObject({
        text: "P3 predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(
        retainedThread?.messages.find((entry) => entry.id === successorMessageId),
      ).toMatchObject({
        text: "P3 exact successor after session closure",
        delivery: { state: "accepted", queued: true },
      });
      expect(retainedThread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "stopped",
        activeTurnId: null,
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(2);
      expect(manager.steerInputs).toHaveLength(0);
    } finally {
      await closeBoundaryHarnesses(fixtureRoot, [harness, restarted]);
    }
  });

  it("P4: retains a transport-only send failure without manufacturing a provider event", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-p4-send-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    manager.sendFailure = new Error("turn/start transport failure");
    let harness: BoundaryHarness | undefined;
    let restarted: BoundaryHarness | undefined;
    const messageId = MessageId.makeUnsafe("message-p4-send-transport");
    try {
      harness = await makeProviderRuntime(dbPath, manager);
      await harness.runtime.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          connectionId: CONNECTION_ID,
          bindingRevision: 0,
          commandId: CommandId.makeUnsafe("cmd-p4-send-transport"),
          threadId: THREAD_ID,
          message: {
            messageId,
            role: "user",
            text: "P4 transport-only send",
            attachments: [],
          },
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          createdAt: "2026-09-07T10:04:00.000Z",
        }),
      );
      await waitFor(async () => manager.sendInputs.length === 1);
      await harness.runtime.runPromise(harness.reactor.drain);
      await harness.runtime.runPromise(harness.ingestion.drain);
      const p4SendTrace = await persistedBoundaryTrace(harness, messageId);
      expect(p4SendTrace.commandDelivery).toMatchObject({
        eventSequence: 6,
        state: "uncertain",
        attemptCount: 1,
      });
      expect(p4SendTrace.messageDelivery).toMatchObject({
        state: "failed",
        queued: false,
        sequence: 7,
      });
      expect(p4SendTrace.pendingStartOutcome).toMatchObject({
        outcome: "pending",
        turnId: "turn:cmd-p4-send-transport",
      });
      expect(p4SendTrace.latestTurn).toMatchObject({
        turnId: "turn:cmd-p4-send-transport",
        state: "running",
        startedAt: null,
      });
      const snapshot = await harness.runtime.runPromise(harness.projection.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.messages.find((entry) => entry.id === messageId)).toMatchObject({
        id: messageId,
        text: "P4 transport-only send",
        delivery: { state: "failed", queued: false },
      });
      expect(thread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: null,
      });
      expect(thread?.session?.lastError).toContain("turn/start transport failure");
      expect(await harness.runtime.runPromise(harness.events.getHighWaterSequence)).toBe(0);
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.startInputs[0]?.managedLaunch?.connectionId).toBe(CONNECTION_ID);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.sendInputs[0]?.threadId).toBe(THREAD_ID);
      expect(manager.sendInputs[0]?.input).toBe("P4 transport-only send");
      expect(manager.steerInputs).toHaveLength(0);

      const cleanupFailures = await disposeBoundaryHarness(harness);
      harness = undefined;
      expect(cleanupFailures).toEqual([]);
      restarted = await makeProviderRuntime(dbPath, manager, false);
      const retained = await restarted.runtime.runPromise(restarted.projection.getSnapshot());
      const retainedTrace = await persistedBoundaryTrace(restarted, messageId);
      const retainedThread = retained.threads.find((entry) => entry.id === THREAD_ID);
      expect(retainedThread?.messages.find((entry) => entry.id === messageId)).toMatchObject({
        id: messageId,
        text: "P4 transport-only send",
        delivery: { state: "failed", queued: false },
      });
      expect(retainedThread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: null,
      });
      expect(retainedTrace.commandDelivery).toMatchObject({
        eventSequence: 6,
        state: "uncertain",
        attemptCount: 1,
      });
      expect(retainedTrace.pendingStartOutcome).toMatchObject({
        outcome: "pending",
        turnId: "turn:cmd-p4-send-transport",
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.steerInputs).toHaveLength(0);
    } finally {
      await closeBoundaryHarnesses(fixtureRoot, [harness, restarted]);
    }
  });

  it("P4: retains the exact queued message after a transport-only steer failure", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-p4-steer-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    manager.steerFailure = new Error("turn/steer transport failure");
    manager.steerFailureNotification = undefined;
    let harness: BoundaryHarness | undefined;
    let restarted: BoundaryHarness | undefined;
    const predecessorMessageId = MessageId.makeUnsafe("message-p4-steer-predecessor");
    const queuedMessageId = MessageId.makeUnsafe("message-p4-steer-queued");
    try {
      harness = await makeProviderRuntime(dbPath, manager);
      await establishRunningPredecessorAndQueuedSuccessor(harness, manager, {
        predecessorMessageId,
        predecessorText: "P4 steer predecessor",
        successorMessageId: queuedMessageId,
        successorText: "P4 exact queued steer message",
        commandPrefix: "cmd-p4-steer",
      });
      await harness.runtime.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer-queued",
          commandId: CommandId.makeUnsafe("cmd-p4-steer-transport"),
          threadId: THREAD_ID,
          messageId: queuedMessageId,
          createdAt: "2026-09-07T10:04:02.000Z",
        }),
      );
      await waitFor(async () => manager.steerInputs.length === 1);
      await harness.runtime.runPromise(harness.reactor.drain);
      await harness.runtime.runPromise(harness.ingestion.drain);
      const p4SteerTrace = await persistedBoundaryTrace(harness, queuedMessageId);
      expect(p4SteerTrace.commandDelivery).toMatchObject({
        eventSequence: 13,
        state: "uncertain",
        attemptCount: 1,
      });
      expect(p4SteerTrace.messageDelivery).toMatchObject({
        state: "failed",
        queued: false,
        sequence: 14,
      });
      expect(p4SteerTrace.pendingStartOutcome).toMatchObject({ outcome: "unknown" });
      const snapshot = await harness.runtime.runPromise(harness.projection.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.messages.find((entry) => entry.id === predecessorMessageId)).toMatchObject({
        id: predecessorMessageId,
        text: "P4 steer predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(thread?.messages.find((entry) => entry.id === queuedMessageId)).toMatchObject({
        id: queuedMessageId,
        text: "P4 exact queued steer message",
      });
      expect(thread?.messages.find((entry) => entry.id === queuedMessageId)?.delivery?.state).toBe(
        "failed",
      );
      expect(thread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: null,
      });
      expect(await harness.runtime.runPromise(harness.events.getHighWaterSequence)).toBe(1);
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.sendInputs[0]?.input).toBe("P4 steer predecessor");
      expect(manager.steerInputs).toHaveLength(1);
      expect(manager.steerInputs[0]?.threadId).toBe(THREAD_ID);
      expect(manager.steerInputs[0]?.input).toBe("P4 exact queued steer message");

      const cleanupFailures = await disposeBoundaryHarness(harness);
      harness = undefined;
      expect(cleanupFailures).toEqual([]);
      restarted = await makeProviderRuntime(dbPath, manager, false);
      const retained = await restarted.runtime.runPromise(restarted.projection.getSnapshot());
      const retainedTrace = await persistedBoundaryTrace(restarted, queuedMessageId);
      const retainedThread = retained.threads.find((entry) => entry.id === THREAD_ID);
      expect(
        retainedThread?.messages.find((entry) => entry.id === predecessorMessageId),
      ).toMatchObject({
        text: "P4 steer predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(retainedThread?.messages.find((entry) => entry.id === queuedMessageId)).toMatchObject({
        text: "P4 exact queued steer message",
        delivery: { state: "failed", queued: false },
      });
      expect(retainedThread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "error",
        activeTurnId: null,
      });
      expect(retainedTrace.commandDelivery).toMatchObject({
        eventSequence: 13,
        state: "uncertain",
        attemptCount: 1,
      });
      expect(retainedTrace.pendingStartOutcome).toMatchObject({ outcome: "unknown" });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.steerInputs).toHaveLength(1);
    } finally {
      await closeBoundaryHarnesses(fixtureRoot, [harness, restarted]);
    }
  });

  it("P5: retains a retryable adapter warning while queued work remains owned by the successor", async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "penkra-provider-p5-"));
    const dbPath = path.join(fixtureRoot, "provider-runtime.sqlite");
    const manager = new ControlledCodexManager();
    let harness: BoundaryHarness | undefined;
    let restarted: BoundaryHarness | undefined;
    const predecessorMessageId = MessageId.makeUnsafe("message-p5-predecessor");
    const successorMessageId = MessageId.makeUnsafe("message-p5-successor");
    try {
      harness = await makeProviderRuntime(dbPath, manager);
      await establishRunningPredecessorAndQueuedSuccessor(harness, manager, {
        predecessorMessageId,
        predecessorText: "P5 predecessor",
        successorMessageId,
        successorText: "P5 exact queued successor",
        commandPrefix: "cmd-p5",
      });
      manager.emitNativeNotification({
        eventId: "evt-p5-retryable-warning",
        createdAt: "2026-09-07T10:05:02.000Z",
        error: {
          message: "Reconnecting... 2/5",
          additionalDetails: "controlled retryable warning fixture",
        },
        willRetry: true,
      });
      await waitFor(
        async () => (await harness!.runtime.runPromise(harness!.events.getHighWaterSequence)) === 2,
      );
      await harness.runtime.runPromise(harness.reactor.drain);
      await harness.runtime.runPromise(harness.ingestion.drain);
      const snapshot = await harness.runtime.runPromise(harness.projection.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      expect(thread?.messages.find((entry) => entry.id === predecessorMessageId)).toMatchObject({
        id: predecessorMessageId,
        text: "P5 predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(thread?.messages.find((entry) => entry.id === successorMessageId)).toMatchObject({
        id: successorMessageId,
        text: "P5 exact queued successor",
        delivery: { state: "queued", queued: true },
      });
      expect(thread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "running",
        activeTurnId: TURN_ID,
        lastError: null,
      });
      const rows = await harness.runtime.runPromise(
        harness.events.readThreadEvents({
          threadId: THREAD_ID,
          throughSequenceInclusive: 2,
          limit: 10,
        }),
      );
      const ascending = rows.toReversed();
      expect(ascending.map((row) => row.sequence)).toEqual([1, 2]);
      expect(ascending.map((row) => row.event.type)).toEqual(["turn.started", "runtime.warning"]);
      expect(ascending[1]?.event).toMatchObject({
        eventId: "evt-p5-retryable-warning",
        createdAt: "2026-09-07T10:05:02.000Z",
        payload: {
          message: "Reconnecting... 2/5",
          detail: {
            error: {
              message: "Reconnecting... 2/5",
              additionalDetails: "controlled retryable warning fixture",
            },
            willRetry: true,
          },
        },
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.sendInputs[0]?.input).toBe("P5 predecessor");
      expect(manager.steerInputs).toHaveLength(0);

      const cleanupFailures = await disposeBoundaryHarness(harness);
      harness = undefined;
      expect(cleanupFailures).toEqual([]);
      restarted = await makeProviderRuntime(dbPath, manager, false);
      const retained = await restarted.runtime.runPromise(restarted.projection.getSnapshot());
      const retainedThread = retained.threads.find((entry) => entry.id === THREAD_ID);
      expect(
        retainedThread?.messages.find((entry) => entry.id === predecessorMessageId),
      ).toMatchObject({
        text: "P5 predecessor",
        delivery: { state: "accepted", queued: false },
      });
      expect(
        retainedThread?.messages.find((entry) => entry.id === successorMessageId),
      ).toMatchObject({
        text: "P5 exact queued successor",
        delivery: { state: "queued", queued: true },
      });
      expect(retainedThread?.session).toMatchObject({
        threadId: THREAD_ID,
        status: "running",
        activeTurnId: TURN_ID,
        lastError: null,
      });
      expect(manager.startInputs).toHaveLength(1);
      expect(manager.sendInputs).toHaveLength(1);
      expect(manager.steerInputs).toHaveLength(0);
    } finally {
      await closeBoundaryHarnesses(fixtureRoot, [harness, restarted]);
    }
  });
});

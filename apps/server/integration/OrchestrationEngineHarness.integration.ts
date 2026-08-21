import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderKind,
  ProviderNativeStateGenerationId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@penkra/contracts";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";

import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionPendingInteractionRepositoryLive } from "../src/persistence/Layers/ProjectionPendingInteractions.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionPendingInteractionRepository } from "../src/persistence/Services/ProjectionPendingInteractions.ts";
import { ThreadProviderBindingRepository } from "../src/persistence/Services/ThreadProviderBindings.ts";
import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapterLive } from "../src/provider/Layers/CodexAdapter.ts";
import { CodexAdapter } from "../src/provider/Services/CodexAdapter.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { ProviderLaunchResolver } from "../src/provider/Services/ProviderLaunchResolver.ts";
import { ProviderTurnSelectionResolver } from "../src/provider/Services/ProviderTurnSelectionResolver.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { TextGeneration } from "../src/textGeneration/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { makeProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import {
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorError,
} from "../src/orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";

export const INTEGRATION_CONNECTION_ID = ProviderConnectionId.makeUnsafe(
  "integration-managed-connection",
);
export const INTEGRATION_INSTALLATION_ID = ProviderInstallationId.makeUnsafe(
  "integration-managed-installation",
);

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

const initializeGitWorkspace = Effect.fn(function* (cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  yield* fileSystem.writeFileString(join(cwd, "README.md"), "v1\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
});

class WaitForTimeoutError extends Schema.TaggedErrorClass<WaitForTimeoutError>()(
  "WaitForTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs?: number,
): Effect.Effect<A, never>;
function waitFor<A, B extends A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => value is B,
  description: string,
  timeoutMs?: number,
): Effect.Effect<B, never>;
function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 30_000,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);

  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({
      schedule: retrySchedule,
      times: maxRetries,
      while: (error) => error === RETRY_SIGNAL,
    }),
    Effect.mapError((error) =>
      error === RETRY_SIGNAL ? new WaitForTimeoutError({ description }) : error,
    ),
    Effect.orDie,
  );
}

class OrchestrationHarnessRuntimeError extends Schema.TaggedErrorClass<OrchestrationHarnessRuntimeError>()(
  "OrchestrationHarnessRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const tryRuntimePromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationHarnessRuntimeError({ operation, cause }),
  });

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    threadId: string,
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "responding" | "confirmed" | "retryable" | "uncertain";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly lifecycleGeneration: string | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "responding" | "confirmed" | "retryable" | "uncertain";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly lifecycleGeneration: string | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly dispose: Effect.Effect<void, never>;
}

interface MakeOrchestrationIntegrationHarnessOptions {
  readonly provider?: ProviderKind;
  readonly realCodex?: boolean;
}

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const provider = options?.provider ?? "codex";
    const useRealCodex = options?.realCodex === true;
    const adapterHarness = useRealCodex
      ? null
      : yield* makeTestProviderAdapterHarness({
          provider,
        });
    const fakeRegistry = adapterHarness
      ? Layer.succeed(ProviderAdapterRegistry, {
          getByProvider: (resolvedProvider) =>
            resolvedProvider === adapterHarness.provider
              ? Effect.succeed(adapterHarness.adapter)
              : Effect.fail(new ProviderUnsupportedError({ provider: resolvedProvider })),
          listProviders: () => Effect.succeed([adapterHarness.provider]),
        } as typeof ProviderAdapterRegistry.Service)
      : null;
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "penkra-orchestration-integration-",
    });
    const workspaceDir = path.join(rootDir, "workspace");
    const { stateDir, dbPath } = yield* deriveServerPaths(rootDir, undefined).pipe(
      Effect.provideService(Path.Path, path),
    );
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* initializeGitWorkspace(workspaceDir);

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const realCodexRegistry = Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const codexAdapter = yield* CodexAdapter;
        return {
          getByProvider: (resolvedProvider) =>
            resolvedProvider === "codex"
              ? Effect.succeed(codexAdapter)
              : Effect.fail(new ProviderUnsupportedError({ provider: resolvedProvider })),
          listProviders: () => Effect.succeed(["codex"] as const),
        } as typeof ProviderAdapterRegistry.Service;
      }),
    ).pipe(
      Layer.provide(makeCodexAdapterLive()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerLayer = useRealCodex
      ? makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(realCodexRegistry),
          Layer.provide(AnalyticsService.layerTest),
        )
      : makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(fakeRegistry!),
          Layer.provide(AnalyticsService.layerTest),
        );

    const runtimeServicesLayer = Layer.mergeAll(
      orchestrationLayer,
      OrchestrationProjectionSnapshotQueryLive,
      ProjectionPendingInteractionRepositoryLive,
      providerLayer,
    );
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
    );
    const providerLaunchResolverLayer = Layer.succeed(ProviderLaunchResolver, {
      resolve: () =>
        Effect.succeed({
          binaryPath: "/integration/managed-provider",
          isolationKey: "integration-managed-isolation",
          profileRoot: path.join(rootDir, "managed-profile"),
          nativeStateRoot: path.join(rootDir, "managed-native-state"),
          connectionId: INTEGRATION_CONNECTION_ID,
          installationId: INTEGRATION_INSTALLATION_ID,
          childEnvironment: (environment: NodeJS.ProcessEnv) => ({
            ...environment,
          }),
        }),
      resolveProfile: () => Effect.die("Provider profile resolution is not used by this harness."),
    } as typeof ProviderLaunchResolver.Service);
    const providerTurnSelectionResolverLayer = Layer.succeed(ProviderTurnSelectionResolver, {
      resolveNewThreadConnection: () => Effect.succeed(INTEGRATION_CONNECTION_ID),
      resolveInitial: () => Effect.die("Initial binding admission is not used by this harness."),
      resolveExisting: (selection) =>
        Effect.succeed({
          threadId: selection.threadId,
          harness: selection.modelSelection?.provider ?? provider,
          connectionId: selection.connectionId ?? INTEGRATION_CONNECTION_ID,
          connectionLabel: "Integration",
          previousConnectionId: INTEGRATION_CONNECTION_ID,
          previousModelId: selection.modelSelection?.model ?? null,
          previousInstallationId: INTEGRATION_INSTALLATION_ID,
          installationId: INTEGRATION_INSTALLATION_ID,
          internalProviderId: null,
          modelId: selection.modelSelection?.model ?? "integration-model",
          modelLabel: selection.modelSelection?.model ?? "Integration model",
          stateRevision: 0,
          bindingRevision: selection.bindingRevision ?? 0,
          changed: false,
          requiresNativeStateMaterialization: false,
        }),
    } as typeof ProviderTurnSelectionResolver.Service);
    const threadProviderBindingLayer = Layer.succeed(ThreadProviderBindingRepository, {
      getHarnessState: (threadId: ThreadId) =>
        Effect.succeed(
          Option.some({
            threadId,
            harness: provider,
            nativeStateGenerationId: ProviderNativeStateGenerationId.makeUnsafe(
              "integration-native-state",
            ),
            providerSessionId: null,
            nativeStateLocatorJson: "null",
            lastVerifiedResumeAt: null,
            revision: 0,
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
          }),
        ),
    } as unknown as typeof ThreadProviderBindingRepository.Service);
    const providerThreadSwitchCoordinatorLayer = Layer.effect(
      ProviderThreadSwitchCoordinator,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        return {
          dispatchTurnStart: ({ command, attachmentPrincipal, cwd }) =>
            engine
              .dispatch(command, {
                attachmentPrincipal,
                ...(cwd ? { cwd } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderThreadSwitchCoordinatorError({
                      detail: "The orchestration harness could not dispatch the turn.",
                      cause,
                    }),
                ),
              ),
          recoverOpen: Effect.void,
        };
      }),
    ).pipe(Layer.provideMerge(runtimeServicesLayer));
    const providerCommandReactorLayer = makeProviderCommandReactorLive().pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateThreadTitle: () => Effect.succeed({ title: "Chat" }),
        }),
      ),
      Layer.provideMerge(threadProviderBindingLayer),
      Layer.provideMerge(providerLaunchResolverLayer),
      Layer.provideMerge(providerTurnSelectionResolverLayer),
      Layer.provideMerge(providerThreadSwitchCoordinatorLayer),
    );
    const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(providerCommandReactorLayer),
    );
    const layer = orchestrationReactorLayer.pipe(
      Layer.provide(persistenceLayer),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);
    const pendingInteractionRepository = yield* tryRuntimePromise(
      "load ProjectionPendingInteractionRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingInteractionRepository)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    yield* tryRuntimePromise("start OrchestrationReactor", () =>
      runtime.runPromise(reactor.start.pipe(Scope.provide(scope))),
    ).pipe(Effect.orDie);
    yield* Effect.sleep(10);

    const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
      threadId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        snapshotQuery
          .getSnapshot()
          .pipe(
            Effect.map(
              (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
            ),
          ),
        (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
        `projected thread '${threadId}'`,
        timeoutMs,
      ) as Effect.Effect<OrchestrationThread, never>;

    const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
        ),
        (events) => events.some(predicate),
        "domain event",
        timeoutMs,
      );

    const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
      threadId,
      requestId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        pendingInteractionRepository
          .getByIdentity({
            threadId: ThreadId.makeUnsafe(threadId),
            interactionKind: "approval",
            requestId: ApprovalRequestId.makeUnsafe(requestId),
          })
          .pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => null,
                onSome: (value) => ({
                  status: value.status,
                  decision: value.decision,
                  lifecycleGeneration: value.lifecycleGeneration,
                  resolvedAt: value.resolvedAt,
                }),
              }),
            ),
          ),
        (
          row,
        ): row is {
          readonly status: "pending" | "responding" | "confirmed" | "retryable" | "uncertain";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly lifecycleGeneration: string | null;
          readonly resolvedAt: string | null;
        } => row !== null && predicate(row),
        `pending approval '${requestId}'`,
        timeoutMs,
      ) as Effect.Effect<
        {
          readonly status: "pending" | "responding" | "confirmed" | "retryable" | "uncertain";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly lifecycleGeneration: string | null;
          readonly resolvedAt: string | null;
        },
        never
      >;

    let disposed = false;
    const dispose = Effect.gen(function* () {
      if (disposed) {
        return;
      }
      disposed = true;

      const shutdown = Effect.gen(function* () {
        const closeScopeExit = yield* Effect.exit(Scope.close(scope, Exit.void));
        const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

        const failureCause = Exit.isFailure(closeScopeExit)
          ? closeScopeExit.cause
          : Exit.isFailure(disposeRuntimeExit)
            ? disposeRuntimeExit.cause
            : null;

        if (failureCause) {
          return yield* Effect.failCause(failureCause);
        }
      });

      yield* shutdown;
    });

    return {
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness,
      engine,
      snapshotQuery,
      providerService,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });

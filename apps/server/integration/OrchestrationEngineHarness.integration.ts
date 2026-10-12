import { ConnectionRateLimitsLive } from "../src/providerUsage/ConnectionRateLimits.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderKind,
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
import { ProviderRuntimeEventRepositoryLive } from "../src/persistence/Layers/ProviderRuntimeEvents.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeDurableProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapterLive } from "../src/provider/Layers/CodexAdapter.ts";
import { CodexAdapter } from "../src/provider/Services/CodexAdapter.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { ProviderDiscoveryService } from "../src/provider/Services/ProviderDiscoveryService.ts";
import { ProviderLaunchResolver } from "../src/provider/Services/ProviderLaunchResolver.ts";
import { ProviderTurnSelectionResolverLive } from "../src/provider/Layers/ProviderTurnSelectionResolver.ts";
import { ProviderConnectionRepository } from "../src/persistence/Services/ProviderConnections.ts";
import { ProviderInstallationRepository } from "../src/persistence/Services/ProviderInstallations.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { TextGeneration } from "../src/textGeneration/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { makeProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderThreadSwitchCoordinatorLive } from "../src/orchestration/Layers/ProviderThreadSwitchCoordinator.ts";
import { ProviderNativeStateMaterializerLive } from "../src/provider/Layers/ProviderNativeStateMaterializer.ts";
import { ThreadPublisher, ThreadPublisherLive } from "../src/cleanCore/ThreadPublisher.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../src/orchestration/Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import { ProviderThreadSwitchCoordinator } from "../src/orchestration/Services/ProviderThreadSwitchCoordinator.ts";
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
  readonly sql: SqlClient.SqlClient;
  readonly publisher: ThreadPublisher["Service"];
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly coordinator: ProviderThreadSwitchCoordinator["Service"];
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
              ? Effect.succeed({
                  ...adapterHarness.adapter,
                  listModels: () =>
                    Effect.succeed({
                      models: [
                        { slug: `test-model-${provider}`, name: "Fixture model" },
                        { slug: "claude-sonnet-4-6", name: "Sonnet" },
                      ],
                    }),
                })
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
    const durableRuntimeEventRepositoryLayer = ProviderRuntimeEventRepositoryLive.pipe(
      Layer.provideMerge(persistenceLayer),
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
      ? makeDurableProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(realCodexRegistry),
          Layer.provide(durableRuntimeEventRepositoryLayer),
          Layer.provide(AnalyticsService.layerTest),
        )
      : makeDurableProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(fakeRegistry!),
          Layer.provide(durableRuntimeEventRepositoryLayer),
          Layer.provide(AnalyticsService.layerTest),
        );

    const runtimeServicesLayer = Layer.mergeAll(
      orchestrationLayer,
      OrchestrationProjectionSnapshotQueryLive,
      ProjectionPendingInteractionRepositoryLive,
      providerLayer,
    );
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(ConnectionRateLimitsLive),
      Layer.provideMerge(ThreadPublisherLive),
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
      resolveProfile: () =>
        Effect.succeed({
          binaryPath: "/integration/managed-provider",
          isolationKey: "integration-discovery",
          profileRoot: path.join(rootDir, "managed-profile"),
          nativeStateRoot: path.join(rootDir, "managed-discovery"),
          connectionId: INTEGRATION_CONNECTION_ID,
          installationId: INTEGRATION_INSTALLATION_ID,
          childEnvironment: (environment: NodeJS.ProcessEnv) => ({ ...environment }),
        }),
    } as typeof ProviderLaunchResolver.Service);
    const providerTurnSelectionResolverLayer = ProviderTurnSelectionResolverLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(ProviderConnectionRepository, {
            getRecord: (id: ProviderConnectionId) =>
              Effect.succeed(
                id === INTEGRATION_CONNECTION_ID
                  ? Option.some({
                      id,
                      harness: provider,
                      authenticationTargetId:
                        provider === "codex" ? "openai-first-party" : "anthropic-first-party",
                      authenticationMethodId: provider === "codex" ? "chatgpt" : "claude-account",
                      label: "Integration",
                      credentialRef: null,
                      profileRef: "integration-profile",
                      providerIdentityId: null,
                      health: "ready",
                      lifecycle: "active",
                      createdAt: "2026-02-24T00:00:00.000Z",
                      updatedAt: "2026-02-24T00:00:00.000Z",
                    })
                  : Option.none(),
              ),
            list: () => Effect.succeed([]),
          } as never),
          Layer.succeed(ProviderInstallationRepository, {
            getActiveRecord: () => Effect.succeed(Option.some({ id: INTEGRATION_INSTALLATION_ID })),
          } as never),
          useRealCodex ? realCodexRegistry : fakeRegistry!,
          providerLaunchResolverLayer,
          ServerSettingsService.layerTest(),
        ),
      ),
    );
    const providerThreadSwitchCoordinatorLayer = ProviderThreadSwitchCoordinatorLive.pipe(
      Layer.provideMerge(ProviderNativeStateMaterializerLive),
      Layer.provideMerge(providerTurnSelectionResolverLayer),
      Layer.provideMerge(ThreadPublisherLive),
      Layer.provideMerge(runtimeServicesLayer),
    );
    const providerCommandReactorLayer = makeProviderCommandReactorLive().pipe(
      Layer.provideMerge(
        Layer.succeed(ProviderDiscoveryService, {
          probeConnection: () => Effect.succeed(false),
        } as never),
      ),
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateThreadTitle: () => Effect.succeed({ title: "Chat" }),
        }),
      ),
      Layer.provideMerge(providerLaunchResolverLayer),
      Layer.provideMerge(providerTurnSelectionResolverLayer),
      Layer.provideMerge(providerThreadSwitchCoordinatorLayer),
    );
    const layer = Layer.merge(runtimeIngestionLayer, providerCommandReactorLayer).pipe(
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const coordinator = yield* tryRuntimePromise("load switch coordinator", () =>
      runtime.runPromise(Effect.service(ProviderThreadSwitchCoordinator)),
    ).pipe(Effect.orDie);
    const sql = yield* Effect.promise(() =>
      runtime.runPromise(Effect.service(SqlClient.SqlClient)),
    );
    const publisher = yield* Effect.promise(() =>
      runtime.runPromise(Effect.service(ThreadPublisher)),
    );
    const ingestion = yield* tryRuntimePromise("load provider runtime ingestion", () =>
      runtime.runPromise(Effect.service(ProviderRuntimeIngestionService)),
    ).pipe(Effect.orDie);
    const dispatcher = yield* tryRuntimePromise("load provider command dispatch", () =>
      runtime.runPromise(Effect.service(ProviderCommandReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    yield* tryRuntimePromise("start provider runtime subscriptions", () =>
      runtime.runPromise(
        ingestion.start.pipe(Effect.andThen(dispatcher.start), Scope.provide(scope)),
      ),
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
      sql,
      publisher,
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness,
      engine,
      coordinator,
      snapshotQuery,
      providerService,
      waitForThread,
      waitForDomainEvent,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });

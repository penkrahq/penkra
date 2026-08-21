import http from "node:http";

import type { ServerSettingsError } from "@penkra/contracts";
import { Effect, Exit, FileSystem, Layer, Path, Schema, Scope, ServiceMap } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { agentGatewayRouteLayer } from "./agentGateway/httpRoute";
import { AgentGatewayCredentials } from "./agentGateway/Services/AgentGatewayCredentials";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState";
import { remoteAccessPolicyError, ServerConfig } from "./config";
import { resolveListeningPort } from "./startupAccess";
import { patchBunWebSocketCloseEventCompatibility } from "./bunWebSocketCompatibility";
import { makeEffectHttpRouteLayer } from "./http";
import { Keybindings } from "./keybindings";
import {
  ManagedAttachmentCleanup,
  type ManagedAttachmentCleanupShape,
} from "./managedAttachmentCleanup";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "./orchestration/Services/ProviderCommandReactor";
import { ProviderThreadSwitchCoordinator } from "./orchestration/Services/ProviderThreadSwitchCoordinator";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor";
import { reconcileRestartStuckTurns } from "./orchestration/startupTurnReconciliation";
import { recoverRestartInterruptedTurns } from "./orchestration/restartTurnRecovery";
import { ProviderSessionReaper } from "./provider/Services/ProviderSessionReaper";
import { ProviderRuntimeReconciler } from "./provider/Services/ProviderRuntimeReconciler";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { runStartupStage } from "./startupTiming";
import { ServerSettingsService } from "./serverSettings";
import { makeServerReadiness } from "./server/readiness";
import { makeServerShutdownController, type ServerShutdownController } from "./serverShutdown";
import { makeBoundedNodeHttpServer } from "./nodeHttpServer";
import { websocketRpcRouteLayer } from "./wsRpc";
import { WorkspaceWatcher, type WorkspaceWatcherShape } from "./workspaceWatcher";

export interface ServerShape {
  readonly start: Effect.Effect<
    {
      readonly nodeServer: http.Server;
      readonly shutdown: Effect.Effect<void>;
    },
    ServerLifecycleError | ServerSettingsError,
    | Scope.Scope
    | ServerConfig
    | AgentGatewayCredentials
    | FileSystem.FileSystem
    | Path.Path
    | Keybindings
    | ManagedAttachmentCleanup
    | ServerLifecycleEvents
    | OrchestrationEngineService
    | OrchestrationReactor
    | ProviderCommandReactor
    | ProviderThreadSwitchCoordinator
    | ProjectionSnapshotQuery
    | ProviderSessionReaper
    | ProviderRuntimeReconciler
    | ProviderService
    | ServerRuntimeStartup
    | ServerSettingsService
    | ThreadDeletionReactor
    | WorkspaceWatcher
    | SqlClient.SqlClient
  >;
  readonly stopSignal: Effect.Effect<void, never>;
}

export class Server extends ServiceMap.Service<Server, ServerShape>()(
  "penkra/effectServer/Server",
) {}

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export function closeServerRuntimePipeline(input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "quiesce" | "drain" | "stop">;
  readonly providerCommandReactor: Pick<ProviderCommandReactorShape, "drain">;
  readonly providerService: Pick<ProviderServiceShape, "closeRuntimeEvents">;
  readonly managedAttachmentCleanup: Pick<ManagedAttachmentCleanupShape, "drain">;
  readonly workspaceWatcher: Pick<WorkspaceWatcherShape, "close">;
  readonly subscriptionsScope: Scope.Closeable;
}): Effect.Effect<void> {
  const runStage = (stage: string, effect: Effect.Effect<void>) =>
    Effect.logInfo("server shutdown stage started", { stage }).pipe(
      Effect.andThen(effect),
      Effect.andThen(Effect.logInfo("server shutdown stage completed", { stage })),
    );

  return runStage("orchestration.quiesce", input.orchestrationEngine.quiesce).pipe(
    // Drain already-admitted commands while every subscriber is live, then wait
    // for provider-side delivery claims to reach a durable settlement. Closing
    // the reactor scope before this second drain can interrupt the narrow window
    // between an external command being claimed and its acceptance being
    // recorded, which quarantines the thread after restart.
    Effect.andThen(runStage("orchestration.drain", input.orchestrationEngine.drain)),
    Effect.andThen(runStage("provider-command-reactor.drain", input.providerCommandReactor.drain)),
    // Provider close now fences terminal runtime events into subscriber workers;
    // scope close drains those workers before the engine accepts its final stop.
    Effect.andThen(runStage("provider-runtime.close", input.providerService.closeRuntimeEvents)),
    Effect.andThen(
      runStage("subscriptions.close", Scope.close(input.subscriptionsScope, Exit.void)),
    ),
    Effect.andThen(runStage("workspace-watcher.close", input.workspaceWatcher.close)),
    Effect.andThen(runStage("managed-attachments.drain", input.managedAttachmentCleanup.drain)),
    Effect.andThen(runStage("orchestration.stop", input.orchestrationEngine.stop)),
  );
}

export const createEffectServer = Effect.fn(function* (
  shutdownController: ServerShutdownController,
) {
  const config = yield* ServerConfig;
  const remotePolicyError = remoteAccessPolicyError(config);
  if (remotePolicyError) {
    return yield* new ServerLifecycleError({
      operation: "validateRemoteAccessPolicy",
      cause: new Error(remotePolicyError),
    });
  }
  const agentGatewayCredentials = yield* AgentGatewayCredentials;
  const keybindings = yield* Keybindings;
  const managedAttachmentCleanup = yield* ManagedAttachmentCleanup;
  const workspaceWatcher = yield* WorkspaceWatcher;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const orchestrationReactor = yield* OrchestrationReactor;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const providerThreadSwitchCoordinator = yield* ProviderThreadSwitchCoordinator;
  const providerService = yield* ProviderService;
  const providerSessionReaper = yield* ProviderSessionReaper;
  const providerRuntimeReconciler = yield* ProviderRuntimeReconciler;
  const runtimeStartup = yield* ServerRuntimeStartup;
  const serverSettings = yield* ServerSettingsService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const readiness = yield* makeServerReadiness;

  yield* keybindings.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );
  yield* serverSettings.start;
  yield* readiness.markPushBusReady;
  yield* readiness.markKeybindingsReady;

  let nodeServer: http.Server | null = null;
  patchBunWebSocketCloseEventCompatibility();
  // Keep embedded/test callers safe if they construct ServerConfig without
  // passing through the CLI's loopback-default resolution.
  const listenOptions = { host: config.host ?? "127.0.0.1", port: config.port };
  const httpServer = yield* makeBoundedNodeHttpServer(() => {
    nodeServer = http.createServer();
    return nodeServer;
  }, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  const routesLayer = Layer.mergeAll(
    makeEffectHttpRouteLayer(readiness, shutdownController),
    websocketRpcRouteLayer,
    agentGatewayRouteLayer,
  );
  const httpApp = yield* HttpRouter.toHttpEffect(routesLayer);
  yield* httpServer
    .serve(httpApp)
    .pipe(
      Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerServe", cause })),
    );

  const listeningPort = resolveListeningPort(
    (nodeServer as http.Server | null)?.address() ?? null,
    config.port,
  );
  agentGatewayCredentials.setListeningPort(listeningPort);
  yield* persistServerRuntimeState({
    path: config.serverRuntimeStatePath,
    state: makePersistedServerRuntimeState({
      config,
      port: listeningPort,
    }),
  }).pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "persistServerRuntimeState", cause }),
    ),
  );
  yield* Effect.addFinalizer(() => clearPersistedServerRuntimeState(config.serverRuntimeStatePath));
  yield* readiness.markHttpListening;

  const subscriptionsScope = yield* Scope.make("sequential");
  const shutdown = yield* Effect.cached(
    closeServerRuntimePipeline({
      orchestrationEngine,
      providerCommandReactor,
      providerService,
      managedAttachmentCleanup,
      workspaceWatcher,
      subscriptionsScope,
    }),
  );
  // The main program runs this explicitly before the application layer begins
  // releasing SQLite and provider services. Keep the finalizer as an idempotent
  // fallback for startup failures and abrupt parent disconnects.
  yield* Effect.addFinalizer(() => shutdown);
  // Clear lightweight orphaned-turn state before provider replay begins. Full
  // history cleanup is forked into this supervised scope by the reconciler and
  // must not delay command readiness.
  yield* runStartupStage(
    "restart-stuck-turns.reconcile",
    reconcileRestartStuckTurns({ backgroundScope: subscriptionsScope }),
  );
  yield* runStartupStage(
    "orchestration-reactor.start",
    Scope.provide(orchestrationReactor.start, subscriptionsScope),
  );
  yield* runStartupStage(
    "thread-deletion-reactor.start",
    Scope.provide(threadDeletionReactor.start(), subscriptionsScope),
  );
  yield* runStartupStage(
    "provider-session-reaper.start",
    Scope.provide(providerSessionReaper.start(), subscriptionsScope),
  );
  yield* runStartupStage(
    "provider-runtime-reconciler.start",
    Scope.provide(providerRuntimeReconciler.start(), subscriptionsScope),
  );
  yield* readiness.markOrchestrationSubscriptionsReady;
  yield* readiness.markTerminalSubscriptionsReady;
  yield* runtimeStartup.markCommandReady;

  yield* lifecycleEvents.publish({
    type: "welcome",
    payload: {
      cwd: config.cwd,
      homeDir: config.homeDir,
      chatWorkspaceRoot: config.chatWorkspaceRoot,
      projectName: config.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? config.cwd,
    },
  });
  yield* lifecycleEvents.publish({
    type: "ready",
    payload: { at: new Date().toISOString() },
  });

  // Durable recovery journals are best-effort startup maintenance. All live
  // subscribers are attached and new commands are safe before these scans and
  // provider resumptions complete, so keep them supervised but off the startup
  // readiness path.
  yield* Effect.gen(function* () {
    yield* orchestrationReactor.reconcileSettledOpenTurns;
    yield* providerThreadSwitchCoordinator.recoverOpen;
    yield* recoverRestartInterruptedTurns;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("post-ready restart recovery failed", { cause }),
    ),
    Effect.forkIn(subscriptionsScope),
    Effect.asVoid,
  );

  if (!nodeServer) {
    return yield* new ServerLifecycleError({ operation: "httpServerListen" });
  }
  return { nodeServer: nodeServer as http.Server, shutdown };
});

export const ServerLive = Layer.effect(
  Server,
  Effect.gen(function* () {
    const shutdownController = yield* makeServerShutdownController();
    return {
      start: createEffectServer(shutdownController) as ServerShape["start"],
      stopSignal: shutdownController.stopSignal,
    } satisfies ServerShape;
  }),
);

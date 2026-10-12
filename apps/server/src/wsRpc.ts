import { getFolderAppTabs, updateFolderAppTabs } from "./cleanCore/folderAppTabs.ts";
import { listArchivedNavigation, listArchivedThreads, restoreThread } from "./cleanCore/archive.ts";
import { ensureDurableThreadWorkspace } from "./scratchWorkspaces.ts";
import { createAndSendThread } from "./cleanCore/createAndSendThread.ts";
import { createThreadFromClient, ThreadLifecycle } from "./cleanCore/threadLifecycle.ts";
import { ThreadSender } from "./cleanCore/ThreadSender.ts";

import {
  type ProviderConnectionId,
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_FEATURE_PATH,
  WS_METHODS,
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsRpcError,
  QueuedEditDraftNotEmptyError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationStartupSnapshot,
  type OrchestrationSyncStreamItem,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
} from "@penkra/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema, Scope, Stream } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcMiddleware, RpcSchema, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import {
  ServerAuth,
  type AuthError,
  type AuthRequest,
  type AuthenticatedSession,
  type ServerAuthShape,
} from "./auth/Services/ServerAuth";
import { SessionCredentialService } from "./auth/Services/SessionCredentialService";
import { ServerConfig, type ServerConfigShape } from "./config";
import { getSpaceNavigationState, updateSpaceNavigationState } from "./spaceNavigationState";
import { realpathNearestExisting } from "./realpathNearestExisting";
import { Keybindings } from "./keybindings";
import { createLocalPreviewGrant } from "./localImageFiles";
import {
  attachmentPrincipalForSession,
  CurrentManagedAttachmentPrincipal,
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
} from "./managedAttachmentPrincipal";
import { Open, resolveAvailableEditors } from "./open";
import { makeDispatchCommandNormalizer } from "./orchestration/dispatchCommandNormalization";
import { describeRejectedPlay } from "./orchestration/playRejectionDiagnostics";
import { makeImportThreadHandler } from "./orchestration/importThreadRoute";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor";
import { ProviderThreadSwitchCoordinator } from "./orchestration/Services/ProviderThreadSwitchCoordinator";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { shouldPublishThreadShellForEvent } from "./orchestration/threadShellEvents";
import { listProviderConnectionManifests } from "./provider/providerConnectionManifests";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { discoverSkillsCatalog, penkraSkillsDir } from "./provider/skillsCatalog";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderConnectionLifecycle } from "./provider/Services/ProviderConnectionLifecycle";
import { ProviderConnectionLoginCoordinator } from "./provider/Services/ProviderConnectionLoginCoordinator";
import { ProviderLaunchResolver } from "./provider/Services/ProviderLaunchResolver";
import { ProviderConnectionRepository } from "./persistence/Services/ProviderConnections";
import { ProviderInstallationRepository } from "./persistence/Services/ProviderInstallations";
import { listProviderUsage } from "./providerUsage";
import { getProviderUsageSnapshot } from "./providerUsageSnapshot";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { isLoopbackHost } from "./startupAccess";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { makeWsStreamAdmission } from "./wsStreamAdmission";
import { listThreadItemsPage } from "./cleanCore/threadItemsPage.ts";
import { findThread, listThreads, searchThreads } from "./cleanCore/threadList.ts";
import { getThreadDraft, setThreadDraft } from "./cleanCore/threadDraft.ts";
import {
  markThreadVisited,
  moveFolder,
  moveSpace,
  publishSidebarRows,
  moveSidebarItem,
  setThreadRuntimeMode,
} from "./cleanCore/threadStore.ts";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher.ts";
import { sidebarChangeStream, threadChangeStream } from "./cleanCore/threadChangeStream.ts";
import { recoverMissingFile } from "./missingFileRecovery";
import { WorkspaceWatcher } from "./workspaceWatcher";
import { makeWsRequestAdmission } from "./wsRequestAdmission";
import {
  provideWsConnectionSession,
  WS_CONNECTION_SESSION_HEADER,
  WsConnectionSessions,
  WsConnectionSessionsLive,
  type WsConnectionSession,
} from "./wsConnectionSessions";
import { negotiateWsCompatibility, validateWsFeatureCompatibility } from "./wsCompatibility";
import {
  requiresWebSocketAuthentication,
  shouldRejectUntrustedRequestOrigin,
} from "./trustedOrigins";
import { bufferLiveUiStream, type LiveUiStreamDropReport } from "./wsStreamBackpressure";
import { makeDurableOrchestrationStream } from "./wsDurableOrchestrationStream";
import { makeCursorSafeSnapshotLiveStream } from "./wsSnapshotLiveStream";
import { makeSyncAcknowledgements } from "./wsSyncAcknowledgements";
import { wsRpcErrorCode } from "./wsRpcErrorMapping";
import { findThreadGuardInvariant } from "./orchestration/Errors.ts";

class WsRequestAdmissionMiddleware extends RpcMiddleware.Service<WsRequestAdmissionMiddleware>()(
  "penkra/WsRequestAdmissionMiddleware",
  { error: WsRpcError, requiredForClient: false },
) {}

const AdmittedWsFeatureRpcGroup = WsFeatureRpcGroup.middleware(WsRequestAdmissionMiddleware);

const wsRequestAdmissionMiddlewareLayer = Layer.effect(
  WsRequestAdmissionMiddleware,
  Effect.gen(function* () {
    const admission = yield* makeWsRequestAdmission;
    const connectionSessions = yield* WsConnectionSessions;
    return ((effect, options) => {
      // Handler fibers descend from the RPC server fiber (forked at layer build),
      // not from the connection's HTTP upgrade fiber, so connection-scoped
      // services must be re-provided here from the connection-session registry.
      const scoped = provideWsConnectionSession(
        effect,
        connectionSessions.lookup(Headers.get(options.headers, WS_CONNECTION_SESSION_HEADER)),
      );
      return RpcSchema.isStreamSchema(options.rpc.successSchema)
        ? scoped
        : admission.guard(options.clientId, options.rpc._tag, scoped);
    }) satisfies RpcMiddleware.RpcMiddleware<never, WsRpcError, never>;
  }),
);

// Relative subdirectories scaffolded under a freshly created chat container workspace root.
const CHAT_WORKSPACE_SUBDIRECTORIES = ["work", "outputs"] as const;

function toWsRpcError(cause: unknown, fallbackMessage: string) {
  const code = wsRpcErrorCode(cause);
  const threadGuard = findThreadGuardInvariant(cause);
  return Schema.is(WsRpcError)(cause)
    ? cause
    : new WsRpcError({
        message:
          threadGuard?.detail ??
          (cause instanceof Error && cause.message.length > 0 ? cause.message : fallbackMessage),
        cause,
        ...(code === undefined ? {} : { code, retryable: false }),
      });
}

const failLiveUiStreamForSnapshotResync = (report: LiveUiStreamDropReport) =>
  Effect.fail(
    new WsRpcError({
      message: `${report.message}; restarting stream to refresh snapshot.`,
    }),
  );

// Must mirror the cases of toShellStreamEvent: events rejected here are dropped
// before the live-UI buffer so the sliding window only holds events that can
// actually project to a shell update.
function isShellRelevantEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "space.created" ||
    event.type === "space.updated" ||
    event.type === "space.archived" ||
    event.type === "space.restored" ||
    event.type === "space.deleted" ||
    event.type === "folder.created" ||
    event.type === "folder.updated" ||
    event.type === "folder.moved" ||
    event.type === "folder.deleted" ||
    (event.aggregateKind === "thread" && shouldPublishThreadShellForEvent(event))
  );
}

function isThreadDetailEventFor(threadId: ThreadId, event: OrchestrationEvent): boolean {
  return (
    event.aggregateKind === "thread" &&
    event.aggregateId === threadId &&
    (event.type === "thread.message-sent" ||
      event.type === "thread.activity-appended" ||
      event.type === "thread.activity-read-model-updated" ||
      event.type === "thread.conversation-rolled-back" ||
      event.type === "thread.session-set")
  );
}

const makeWsRpcHandlersLayer = () =>
  AdmittedWsFeatureRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const providerCommandReactor = yield* ProviderCommandReactor;
      const providerThreadSwitchCoordinator = yield* ProviderThreadSwitchCoordinator;
      const path = yield* Path.Path;
      const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
      const providerAdapterRegistry = yield* ProviderAdapterRegistry;
      const providerDiscoveryService = yield* ProviderDiscoveryService;
      const providerHealth = yield* ProviderHealth;
      const providerService = yield* ProviderService;
      const providerConnectionLifecycle = yield* ProviderConnectionLifecycle;
      const providerConnectionLoginCoordinator = yield* ProviderConnectionLoginCoordinator;
      const providerLaunchResolver = yield* ProviderLaunchResolver;
      const providerConnections = yield* ProviderConnectionRepository;
      const providerInstallations = yield* ProviderInstallationRepository;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const runtimeStartup = yield* ServerRuntimeStartup;
      const serverEnvironment = yield* ServerEnvironment;
      const serverSettings = yield* ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      const threadPublisher = yield* ThreadPublisher;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const workspaceWatcher = yield* WorkspaceWatcher;
      const syncAcknowledgements = makeSyncAcknowledgements();
      const streamAdmission = yield* makeWsStreamAdmission();
      const logThreadResnapshotRequired = (
        threadId: string,
        report: {
          readonly snapshotSequence: number;
          readonly highWaterSequence: number;
          readonly replayCount: number;
          readonly replayLimit: number;
        },
      ) => Effect.logWarning("Thread stream requires a new snapshot", { threadId, ...report });

      const canonicalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (
        workspaceRoot: string,
        options: { readonly createIfMissing?: boolean } = {},
      ) {
        const rawWorkspaceRoot = workspaceRoot.trim();
        const expandedWorkspaceRoot =
          rawWorkspaceRoot === "~"
            ? config.homeDir
            : rawWorkspaceRoot.startsWith("~/") || rawWorkspaceRoot.startsWith("~\\")
              ? path.join(config.homeDir, rawWorkspaceRoot.slice(2))
              : rawWorkspaceRoot;
        const normalizedWorkspaceRoot = path.resolve(expandedWorkspaceRoot);
        const statWorkspace = () =>
          recoverMissingFile(fileSystem.stat(normalizedWorkspaceRoot)).pipe(
            Effect.mapError(
              (cause) => new WsRpcError({ message: "Failed to inspect project directory", cause }),
            ),
          );
        let workspaceStat = yield* statWorkspace();
        if (!workspaceStat) {
          if (!options.createIfMissing) {
            return yield* new WsRpcError({
              message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
            });
          }
          yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
                  cause,
                }),
            ),
          );
          workspaceStat = yield* statWorkspace();
          if (!workspaceStat) {
            return yield* new WsRpcError({
              message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
            });
          }
        }
        if (workspaceStat.type !== "Directory") {
          return yield* new WsRpcError({
            message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
          });
        }
        return yield* realpathNearestExisting(normalizedWorkspaceRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      });
      // Shared idempotent scaffolding for managed chat workspace subdirectories.
      const prepareWorkspaceSubdirectories = Effect.fnUntraced(function* (
        workspaceRoot: string,
        relativeDirnames: readonly string[],
      ) {
        for (const dirname of relativeDirnames) {
          const childPath = path.join(workspaceRoot, dirname);
          yield* fileSystem.makeDirectory(childPath, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: `Failed to create workspace directory: ${childPath}`,
                  cause,
                }),
            ),
          );
        }
      });
      const prepareChatWorkspaceRoot = (workspaceRoot: string) =>
        prepareWorkspaceSubdirectories(workspaceRoot, CHAT_WORKSPACE_SUBDIRECTORIES);
      const normalizeDispatchCommand = makeDispatchCommandNormalizer<WsRpcError>({
        attachmentsDir: config.attachmentsDir,
        chatWorkspaceRoot: config.chatWorkspaceRoot,
        fileSystem,
        path,
        canonicalizeProjectWorkspaceRoot,
        prepareChatWorkspaceRoot,
      });

      const importThread = makeImportThreadHandler({
        projectionSnapshotQuery: projectionReadModelQuery,
      });

      const dispatchOrchestrationCommand = (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          const attachmentPrincipal = yield* CurrentManagedAttachmentPrincipal;
          if (command.type === "thread.turn.start") {
            const thread = yield* projectionReadModelQuery.getThreadShellById(command.threadId);
            const project = yield* Option.match(thread, {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (value) => projectionReadModelQuery.getFolderShellById(value.folderId),
            });
            const cwd = Option.map(
              thread,
              (value) =>
                Option.getOrNull(project)?.workspaceRoot ??
                ensureDurableThreadWorkspace(value.id, config.stateDir),
            );
            return yield* runtimeStartup.enqueueCommand(
              providerThreadSwitchCoordinator.dispatchTurnStart({
                command,
                attachmentPrincipal,
                ...(Option.isSome(cwd) ? { cwd: cwd.value } : {}),
              }),
            );
          }
          return yield* runtimeStartup.enqueueCommand(
            orchestrationEngine.dispatch(command, { attachmentPrincipal }),
          );
        });

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providerStatuses = yield* providerHealth.getStatuses;
        return {
          cwd: config.cwd,
          homeDir: config.homeDir,
          chatWorkspaceRoot: config.chatWorkspaceRoot,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors: resolveAvailableEditors(),
        };
      });

      const getOrchestrationHighWaterSequence = orchestrationEngine.getEventHighWaterSequence.pipe(
        Effect.mapError((cause) =>
          toWsRpcError(cause, "Failed to capture orchestration high-water sequence"),
        ),
      );

      const loadStartupSnapshot: Effect.Effect<OrchestrationStartupSnapshot, WsRpcError> =
        projectionReadModelQuery
          .getStartupSnapshot()
          .pipe(Effect.mapError((cause) => toWsRpcError(cause, "Failed to load startup snapshot")));

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, WsRpcError> => {
        switch (event.type) {
          case "space.created":
          case "space.restored":
            return projectionReadModelQuery.getSpaceShellById(event.payload.spaceId).pipe(
              Effect.map((space) =>
                Option.map(space, (nextSpace) => ({
                  kind: "space-upserted" as const,
                  sequence: event.sequence,
                  space: nextSpace,
                })),
              ),
              Effect.mapError((cause) =>
                toWsRpcError(cause, "Failed to read a Space shell update"),
              ),
            );
          case "space.updated":
            return projectionReadModelQuery.getSpaceShellById(event.payload.spaceId).pipe(
              Effect.map((space) =>
                Option.map(space, (nextSpace) => ({
                  kind: "space-upserted" as const,
                  sequence: event.sequence,
                  space: nextSpace,
                })),
              ),
              Effect.mapError((cause) =>
                toWsRpcError(cause, "Failed to read a Space shell update"),
              ),
            );
          case "space.deleted":
          case "space.archived":
            return Effect.succeed(
              Option.some({
                kind: "space-removed" as const,
                sequence: event.sequence,
                spaceId: event.payload.spaceId,
                updatedAt:
                  event.type === "space.deleted"
                    ? event.payload.deletedAt
                    : event.payload.archivedAt,
                preserveAssignments: event.type === "space.archived",
              }),
            );
          case "folder.created":
          case "folder.updated":
          case "folder.moved":
            return projectionReadModelQuery.getFolderShellById(event.payload.folderId).pipe(
              Effect.map((folder) =>
                Option.map(folder, (nextFolder) => ({
                  kind: "folder-upserted" as const,
                  sequence: event.sequence,
                  folder: nextFolder,
                })),
              ),
              Effect.mapError((cause) =>
                toWsRpcError(cause, "Failed to read a project shell update"),
              ),
            );
          case "folder.deleted":
            return Effect.succeed(
              Option.some({
                kind: "folder-removed" as const,
                sequence: event.sequence,
                folderId: event.payload.folderId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") return Effect.succeed(Option.none());
            return projectionReadModelQuery
              .getThreadShellById(ThreadId.makeUnsafe(String(event.aggregateId)))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.mapError((cause) =>
                  toWsRpcError(cause, "Failed to read a thread shell update"),
                ),
              );
        }
      };

      // Archived navigation is not retained by the web. Restore events publish their
      // complete bounded rows once, for every connected renderer and command source.
      const navigationEvents = yield* orchestrationEngine.subscribeDomainEvents;
      yield* Stream.runForEach(navigationEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "space.restored") {
            const space = yield* projectionReadModelQuery.getSpaceShellById(event.payload.spaceId);
            if (Option.isSome(space))
              threadPublisher.publishSidebar({
                kind: "navigation.restored",
                spaces: [space.value],
                folders: [],
              });
          } else if (event.type === "folder.updated" && event.payload.archivedAt === null) {
            const folder = yield* projectionReadModelQuery.getFolderShellById(
              event.payload.folderId,
            );
            if (Option.isSome(folder))
              threadPublisher.publishSidebar({
                kind: "navigation.restored",
                spaces: [],
                folders: [folder.value],
              });
          }
        }),
      ).pipe(Effect.forkScoped);

      const rpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
        effect.pipe(Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)));

      return AdmittedWsFeatureRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const command = input;
              yield* Effect.logInfo("orchestration command received").pipe(
                Effect.annotateLogs({
                  commandId: command.commandId,
                  commandType: command.type,
                  ...(command.type === "thread.turn.start" || "threadId" in command
                    ? { threadId: command.threadId }
                    : {}),
                  ...("folderId" in command ? { folderId: command.folderId } : {}),
                }),
              );
              const { command: normalizedCommand } = yield* normalizeDispatchCommand({ command });
              const lifecycleLogContext = {
                commandId: normalizedCommand.commandId,
                commandType: normalizedCommand.type,
                ...("threadId" in normalizedCommand
                  ? { threadId: normalizedCommand.threadId }
                  : {}),
                ...("folderId" in normalizedCommand
                  ? { folderId: normalizedCommand.folderId }
                  : {}),
                ...(normalizedCommand.type === "thread.turn.start"
                  ? {
                      bindingRevision: normalizedCommand.bindingRevision ?? null,
                      modelProvider: normalizedCommand.modelSelection?.provider ?? null,
                      modelSlug: normalizedCommand.modelSelection?.model ?? null,
                    }
                  : {}),
              };
              const result = yield* dispatchOrchestrationCommand(normalizedCommand).pipe(
                Effect.tap((receipt) =>
                  Effect.logInfo("orchestration command accepted").pipe(
                    Effect.annotateLogs({
                      ...lifecycleLogContext,
                      resultSequence: receipt.sequence,
                    }),
                  ),
                ),
                Effect.tapError((cause) =>
                  Effect.gen(function* () {
                    const playContext =
                      normalizedCommand.type === "thread.turn.recover" &&
                      normalizedCommand.reason === "play"
                        ? yield* Effect.gen(function* () {
                            const thread = yield* projectionReadModelQuery
                              .getThreadDetailById(normalizedCommand.threadId)
                              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
                            const rows = yield* sql<{
                              connectionId: ProviderConnectionId | null;
                            }>`SELECT connection_id AS "connectionId" FROM threads WHERE id=${normalizedCommand.threadId}`;
                            return describeRejectedPlay(
                              normalizedCommand,
                              Option.getOrNull(thread),
                              rows[0]?.connectionId,
                            );
                          })
                        : {};
                    yield* Effect.logWarning("orchestration command rejected").pipe(
                      Effect.annotateLogs({
                        ...lifecycleLogContext,
                        ...playContext,
                        cause: cause instanceof Error ? cause.message : String(cause),
                      }),
                    );
                  }),
                ),
              );
              return result;
            }),
            "Failed to dispatch orchestration command",
          ),
        [ORCHESTRATION_WS_METHODS.importThread]: (input) =>
          rpcEffect(importThread(input), "Failed to import thread"),
        [ORCHESTRATION_WS_METHODS.getSnapshot]: () =>
          rpcEffect(
            projectionReadModelQuery.getSnapshot(),
            "Failed to load orchestration snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]: (input) =>
          rpcEffect(
            projectionReadModelQuery
              .getThreadDetailSnapshotById(input.threadId)
              .pipe(Effect.map(Option.getOrNull)),
            "Failed to load orchestration thread detail snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.getThreadTurnsPage]: (input) =>
          rpcEffect(
            projectionReadModelQuery.getThreadTurnsPage(input),
            "Failed to load orchestration Thread turns",
          ),
        [ORCHESTRATION_WS_METHODS.getPendingStartOutcome]: (input) =>
          rpcEffect(
            projectionReadModelQuery.getPendingStartOutcome(input),
            "Failed to load pending start outcome",
          ),
        [ORCHESTRATION_WS_METHODS.subscribeSync]: (input, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "orchestration.sync" },
            Stream.unwrap(
              Effect.gen(function* () {
                const acknowledgementLease = yield* syncAcknowledgements.open(clientId);
                yield* Effect.addFinalizer(() =>
                  acknowledgementLease.close.pipe(
                    Effect.andThen(
                      Effect.logInfo("orchestration synchronization closed").pipe(
                        Effect.annotateLogs({ clientId }),
                      ),
                    ),
                  ),
                );
                yield* Effect.logInfo("orchestration synchronization subscribed").pipe(
                  Effect.annotateLogs({
                    clientId,
                    resumeAfterSequence: input.afterSequenceExclusive ?? null,
                  }),
                );
                const source = makeDurableOrchestrationStream({
                  ...(input.afterSequenceExclusive === undefined
                    ? {}
                    : { afterSequenceExclusive: input.afterSequenceExclusive }),
                  subscribeLive: orchestrationEngine.subscribeDomainEvents,
                  snapshot: loadStartupSnapshot,
                  getHighWaterSequence: getOrchestrationHighWaterSequence,
                  onReplayRange: (range) =>
                    Effect.logDebug("orchestration synchronization durable replay").pipe(
                      Effect.annotateLogs({ clientId, ...range }),
                    ),
                  replay: (fromSequenceExclusive, throughSequenceInclusive) =>
                    orchestrationEngine
                      .readEventsThrough(fromSequenceExclusive, throughSequenceInclusive)
                      .pipe(
                        Stream.mapError((cause) =>
                          toWsRpcError(cause, "Failed to replay orchestration synchronization"),
                        ),
                      ),
                });

                return source.pipe(
                  Stream.mapEffect((item) => {
                    const sequence =
                      item.kind === "snapshot"
                        ? item.snapshot.snapshotSequence
                        : item.event.sequence;
                    return acknowledgementLease.recordDelivery(sequence).pipe(
                      Effect.tap(() =>
                        Effect.logDebug("orchestration synchronization delivery prepared").pipe(
                          Effect.annotateLogs({
                            clientId,
                            deliveryKind: item.kind,
                            sequence,
                          }),
                        ),
                      ),
                      Effect.as<OrchestrationSyncStreamItem>(
                        item.kind === "snapshot"
                          ? {
                              kind: "snapshot",
                              deliveryId: acknowledgementLease.deliveryId,
                              snapshot: item.snapshot,
                            }
                          : {
                              kind: "event",
                              deliveryId: acknowledgementLease.deliveryId,
                              event: item.event,
                            },
                      ),
                    );
                  }),
                );
              }),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.acknowledgeSync]: (input, { clientId }) =>
          syncAcknowledgements.acknowledge(clientId, input),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "orchestration.shell" },
            makeCursorSafeSnapshotLiveStream({
              subscribeLive: orchestrationEngine.subscribeDomainEvents.pipe(
                Effect.map((stream) =>
                  bufferLiveUiStream(stream.pipe(Stream.filter(isShellRelevantEvent)), {
                    label: "orchestration.shell",
                    onDroppedEvents: failLiveUiStreamForSnapshotResync,
                  }),
                ),
              ),
              snapshot: projectionReadModelQuery
                .getStartupSnapshot()
                .pipe(
                  Effect.mapError((cause) => toWsRpcError(cause, "Failed to load shell snapshot")),
                ),
              snapshotSequence: (snapshot) => snapshot.snapshotSequence,
              getHighWaterSequence: getOrchestrationHighWaterSequence,
              replay: (fromSequenceExclusive, throughSequenceInclusive) =>
                orchestrationEngine
                  .readEventsThrough(fromSequenceExclusive, throughSequenceInclusive)
                  .pipe(
                    Stream.filter(isShellRelevantEvent),
                    Stream.mapError((cause) =>
                      toWsRpcError(cause, "Failed to replay shell events"),
                    ),
                  ),
            }).pipe(
              Stream.mapEffect((item) =>
                item.kind === "snapshot"
                  ? Effect.succeed(
                      Option.some<OrchestrationShellStreamItem>({
                        kind: "snapshot",
                        snapshot: item.snapshot,
                      }),
                    )
                  : toShellStreamEvent(item.event),
              ),
              Stream.flatMap((item) =>
                Option.isSome(item) ? Stream.succeed(item.value) : Stream.empty,
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeShell]: () => Effect.void,
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input, { clientId }) =>
          streamAdmission.guard(
            clientId,
            {
              key: `orchestration.thread:${input.threadId}`,
              threadId: input.threadId,
            },
            makeCursorSafeSnapshotLiveStream({
              onResnapshotRequired: (report) => logThreadResnapshotRequired(input.threadId, report),
              subscribeLive: orchestrationEngine.subscribeDomainEvents.pipe(
                Effect.map((stream) =>
                  bufferLiveUiStream(
                    stream.pipe(
                      Stream.filter((event) => isThreadDetailEventFor(input.threadId, event)),
                    ),
                    {
                      label: "orchestration.thread-detail",
                      onDroppedEvents: failLiveUiStreamForSnapshotResync,
                    },
                  ),
                ),
              ),
              snapshot: projectionReadModelQuery.getThreadDetailSnapshotById(input.threadId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      projectionReadModelQuery.getSnapshotSequence().pipe(
                        Effect.map(({ snapshotSequence }) => ({
                          detail: Option.none<OrchestrationThreadDetailSnapshot>(),
                          snapshotSequence,
                        })),
                      ),
                    onSome: (detail) =>
                      Effect.succeed({
                        detail: Option.some(detail),
                        snapshotSequence: detail.snapshotSequence,
                      }),
                  }),
                ),
                Effect.mapError((cause) => toWsRpcError(cause, "Failed to load thread snapshot")),
              ),
              snapshotSequence: (snapshot) => snapshot.snapshotSequence,
              getHighWaterSequence: getOrchestrationHighWaterSequence,
              replay: (fromSequenceExclusive, throughSequenceInclusive) =>
                orchestrationEngine
                  .readEventsThrough(fromSequenceExclusive, throughSequenceInclusive)
                  .pipe(
                    Stream.filter((event) => isThreadDetailEventFor(input.threadId, event)),
                    Stream.mapError((cause) =>
                      toWsRpcError(cause, "Failed to replay thread events"),
                    ),
                  ),
            }).pipe(
              Stream.flatMap((item) => {
                if (item.kind === "event") {
                  return Stream.succeed<OrchestrationThreadStreamItem>({
                    kind: "event",
                    event: item.event,
                  });
                }
                // A silently empty snapshot would leave the client waiting forever
                // for thread history; fail identifiably so it can surface the state.
                return Option.isSome(item.snapshot.detail)
                  ? Stream.succeed<OrchestrationThreadStreamItem>({
                      kind: "snapshot",
                      snapshot: item.snapshot.detail.value,
                    })
                  : Stream.fail(
                      new WsRpcError({
                        message: `Thread detail snapshot not found for thread ${input.threadId}.`,
                        code: "THREAD_SNAPSHOT_NOT_FOUND",
                        retryable: false,
                      }),
                    );
              }),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeThread]: () => Effect.void,
        [WS_METHODS.subscribeOrchestrationDomainEvents]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "orchestration.domain-events" },
            bufferLiveUiStream(orchestrationEngine.streamDomainEvents, {
              label: "orchestration.domain-events",
            }),
          ),

        [WS_METHODS.projectsListDirectories]: (input) =>
          rpcEffect(
            workspaceEntries.listDirectories(input),
            "Failed to list workspace directories",
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          rpcEffect(workspaceEntries.search(input), "Failed to search workspace entries"),
        [WS_METHODS.projectsSearchLocalEntries]: (input) =>
          rpcEffect(workspaceEntries.searchLocal(input), "Failed to search local entries"),
        [WS_METHODS.projectsReadFile]: (input) =>
          rpcEffect(workspaceFileSystem.readFile(input), "Failed to read workspace file"),
        [WS_METHODS.projectsCreateLocalFilePreviewGrant]: (input) =>
          rpcEffect(
            Effect.promise(() => createLocalPreviewGrant({ requestedPath: input.path })),
            "Failed to create local file preview grant",
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          rpcEffect(workspaceFileSystem.writeFile(input), "Failed to write workspace file"),
        [WS_METHODS.subscribeProjectWorkspaceChanges]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "folders.workspace-changes" },
            bufferLiveUiStream(workspaceWatcher.stream, {
              label: "folders.workspace-changes",
            }),
          ),
        [WS_METHODS.filesystemBrowse]: (input) =>
          rpcEffect(workspaceEntries.browse(input), "Failed to browse filesystem"),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          rpcEffect(open.openInEditor(input), "Failed to open editor"),

        [WS_METHODS.serverGetConfig]: () =>
          rpcEffect(loadServerConfig, "Failed to load server config"),
        [WS_METHODS.cleanCoreSubscribeSidebar]: () => sidebarChangeStream(threadPublisher),
        [WS_METHODS.cleanCoreGetThreadRuntime]: (input) =>
          rpcEffect(
            Effect.flatMap(Effect.service(ThreadSender), (sender) =>
              sender.getRuntime(input.threadId),
            ),
            "Failed to read the provider turn",
          ),
        [WS_METHODS.cleanCoreInterruptThread]: (input) =>
          rpcEffect(
            Effect.flatMap(Effect.service(ThreadSender), (sender) =>
              sender.interrupt(input.threadId),
            ),
            "Failed to interrupt the provider turn",
          ),
        [WS_METHODS.cleanCoreGetThread]: (input) =>
          rpcEffect(findThread(input.threadId), "Failed to read the thread"),
        [WS_METHODS.cleanCoreSendMessage]: (input) =>
          rpcEffect(
            runtimeStartup.enqueueCommand(
              Effect.flatMap(Effect.service(ThreadSender), (sender) => sender.send(input)),
            ),
            "Failed to send the message",
          ),
        [WS_METHODS.cleanCoreCancelQueuedMessage]: (input) =>
          rpcEffect(
            Effect.flatMap(Effect.service(ThreadSender), (sender) =>
              sender
                .cancelQueued(input)
                .pipe(Effect.map((result) => ({ ...result, messageId: input.messageId }))),
            ),
            "Failed to remove the queued message",
          ),
        [WS_METHODS.cleanCoreEditQueuedMessage]: (input) =>
          Effect.flatMap(Effect.service(ThreadSender), (sender) =>
            sender
              .editQueued(input)
              .pipe(Effect.map((result) => ({ ...result, messageId: input.messageId }))),
          ).pipe(
            Effect.mapError((error) =>
              Schema.is(QueuedEditDraftNotEmptyError)(error)
                ? error
                : toWsRpcError(error, "Failed to edit the queued message"),
            ),
          ),
        [WS_METHODS.cleanCoreGetFolders]: (input) =>
          rpcEffect(
            projectionReadModelQuery.getFolderShellsByIds(input.folderIds),
            "Failed to read folders",
          ),
        [WS_METHODS.cleanCoreGetThreadShell]: (input) =>
          rpcEffect(
            Effect.flatMap(Effect.service(ProjectionSnapshotQuery), (query) =>
              query.getThreadShellById(input.threadId).pipe(Effect.map(Option.getOrNull)),
            ),
            "Failed to read the thread shell",
          ),
        [WS_METHODS.cleanCoreCreateAndSendThread]: (input) =>
          rpcEffect(
            runtimeStartup.enqueueCommand(
              Effect.gen(function* () {
                const result = yield* createAndSendThread(input);
                const query = yield* ProjectionSnapshotQuery;
                const shell = yield* query.getThreadShellById(result.thread.id);
                if (Option.isNone(shell))
                  return yield* Effect.fail(new Error("The created thread is not available."));
                return { ...result, shell: shell.value };
              }),
            ),
            "Failed to create and send the thread",
          ),
        [WS_METHODS.cleanCoreGetFolderAppTabs]: (input) =>
          rpcEffect(getFolderAppTabs(input), "Failed to read App tabs"),
        [WS_METHODS.cleanCoreUpdateFolderAppTabs]: (input) =>
          rpcEffect(updateFolderAppTabs(input), "Failed to update App tabs"),
        [WS_METHODS.cleanCoreCreateThread]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const result = yield* createThreadFromClient(input);
              const query = yield* ProjectionSnapshotQuery;
              const shell = yield* query.getThreadShellById(result.thread.id);
              if (Option.isNone(shell))
                return yield* Effect.fail(new Error("The created thread is not available."));
              return { ...result, shell: shell.value };
            }),
            "Failed to create the thread",
          ),
        [WS_METHODS.cleanCoreSearchThreads]: (input) =>
          rpcEffect(searchThreads(input), "Failed to search threads"),
        [WS_METHODS.cleanCoreListArchivedNavigation]: () =>
          rpcEffect(listArchivedNavigation(), "Failed to load the archive"),
        [WS_METHODS.cleanCoreListArchivedThreads]: (input) =>
          rpcEffect(listArchivedThreads(input), "Failed to load archived chats"),
        [WS_METHODS.cleanCoreRestoreThread]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const sender = yield* ThreadSender;
              if (yield* sender.runExclusive(input.threadId, restoreThread(input)))
                threadPublisher.publish({ threadId: input.threadId });
            }),
            "Failed to restore the chat",
          ),
        [WS_METHODS.cleanCoreListThreads]: (input) =>
          rpcEffect(listThreads(input), "Failed to load the thread list"),
        [WS_METHODS.cleanCoreUpdateThread]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const update = input.update;
              const publish = (threadId: string) => threadPublisher.publish({ threadId });
              switch (update.action) {
                case "rename":
                case "archive":
                case "delete":
                  yield* Effect.flatMap(Effect.service(ThreadLifecycle), (lifecycle) =>
                    lifecycle.update(update),
                  );
                  return;
                case "moveFolder": {
                  const changed = yield* moveFolder(update);
                  yield* publishSidebarRows(threadPublisher, "folder", changed.folderIds);
                  for (const threadId of changed.threadIds) publish(threadId);
                  return;
                }
                case "moveSpace": {
                  yield* publishSidebarRows(threadPublisher, "space", yield* moveSpace(update));
                  return;
                }
                case "visit": {
                  if (yield* markThreadVisited(update)) publish(update.threadId);
                  return;
                }
                case "runtimeMode": {
                  if (yield* setThreadRuntimeMode(update)) publish(update.threadId);
                  return;
                }
                case "moveSidebarItem": {
                  for (const threadId of yield* moveSidebarItem(update)) publish(threadId);
                  return;
                }
              }
            }),
            "Failed to update the thread",
          ),
        [WS_METHODS.cleanCoreListThreadItemsPage]: (input) =>
          rpcEffect(listThreadItemsPage(input), "Failed to load a thread items page"),
        [WS_METHODS.cleanCoreGetThreadDraft]: (input) =>
          rpcEffect(getThreadDraft(input.threadId), "Failed to load the thread draft"),
        [WS_METHODS.cleanCoreSetThreadDraft]: (input) =>
          rpcEffect(
            setThreadDraft(threadPublisher, input.threadId, input.draft, input.updatedAt),
            "Failed to save the thread draft",
          ),
        [WS_METHODS.cleanCoreSubscribeThread]: (input) =>
          threadChangeStream(threadPublisher, input.threadId),
        [WS_METHODS.cleanCoreAnswerThreadQuestion]: (input) =>
          rpcEffect(
            providerService.respondToUserInput({
              threadId: input.threadId,
              requestId: input.requestId,
              ...(input.lifecycleGeneration !== undefined
                ? { lifecycleGeneration: input.lifecycleGeneration }
                : {}),
              answers: input.answers,
            }),
            "Failed to answer the thread question",
          ),

        [WS_METHODS.serverGetEnvironment]: () =>
          rpcEffect(serverEnvironment.getDescriptor, "Failed to load server environment"),
        [WS_METHODS.serverGetSettings]: () =>
          rpcEffect(serverSettings.getSettingsView, "Failed to load server settings"),
        [WS_METHODS.serverUpdateSettings]: (input) =>
          rpcEffect(serverSettings.updateSettingsView(input), "Failed to update server settings"),
        [WS_METHODS.serverGetSpaceNavigationState]: () =>
          rpcEffect(getSpaceNavigationState(sql), "Failed to load Space navigation state"),
        [WS_METHODS.serverUpdateSpaceNavigationState]: (input) =>
          rpcEffect(
            updateSpaceNavigationState(sql, input),
            "Failed to update Space navigation state",
          ),
        [WS_METHODS.serverRefreshProviders]: () =>
          rpcEffect(
            providerHealth.refresh.pipe(Effect.map((providers) => ({ providers }))),
            "Failed to refresh providers",
          ),
        [WS_METHODS.providerGetConnections]: (input) =>
          rpcEffect(
            Effect.all({
              connections: providerConnections.list({
                includeTerminated: input.includeTerminated === true,
              }),
              installations: providerInstallations.list(),
              anonymousRoutes: Effect.succeed(
                listProviderConnectionManifests().flatMap(({ harness, anonymous }) => {
                  return (anonymous?.internalProviderIds ?? []).map((internalProviderId) => ({
                    harness,
                    internalProviderId,
                    groupLabel: anonymous!.groupLabel,
                    label: anonymous!.label,
                  }));
                }),
              ),
              authenticationMethods: Effect.succeed(
                listProviderConnectionManifests().flatMap(
                  ({ harness, staticCredentialMethods, managedLoginMethods }) => [
                    ...managedLoginMethods.map((method) =>
                      method.loginMechanism === "secret-import"
                        ? {
                            harness,
                            authenticationTargetId: method.authenticationTargetId,
                            authenticationMethodId: method.authenticationMethodId,
                            kind: "managed-secret" as const,
                            label: method.label,
                            groupLabel: method.groupLabel,
                            secretPlaceholder: method.secretPlaceholder,
                            internalProviderIds: [...method.internalProviderIds],
                          }
                        : {
                            harness,
                            authenticationTargetId: method.authenticationTargetId,
                            authenticationMethodId: method.authenticationMethodId,
                            kind: "managed-login" as const,
                            label: method.label,
                            groupLabel: method.groupLabel,
                            internalProviderIds: [...method.internalProviderIds],
                          },
                    ),
                    ...staticCredentialMethods.map((method) => ({
                      harness,
                      authenticationTargetId: method.authenticationTargetId,
                      authenticationMethodId: method.authenticationMethodId,
                      kind: "static-secret" as const,
                      label: method.label,
                      groupLabel: method.groupLabel,
                      secretPlaceholder: method.secretPlaceholder,
                      internalProviderIds: [...method.internalProviderIds],
                    })),
                  ],
                ),
              ),
            }),
            "Failed to load Connections",
          ),
        [WS_METHODS.providerRetryAuthConnection]: (input) =>
          rpcEffect(
            providerCommandReactor.retryAuthConnection(input.connectionId),
            "Failed to retry the Connection",
          ),
        [WS_METHODS.providerCreateStaticConnection]: (input) =>
          rpcEffect(
            providerConnectionLifecycle.createStatic(input),
            "Failed to add the Connection",
          ),
        [WS_METHODS.providerBeginConnectionLogin]: (input) =>
          rpcEffect(
            providerConnectionLoginCoordinator.begin(input),
            "Failed to begin Connection sign in",
          ),
        [WS_METHODS.providerSubscribeConnectionLogin]: (input, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: `provider.login:${input.operationId}` },
            providerConnectionLoginCoordinator
              .subscribe(input)
              .pipe(
                Stream.mapError((cause) => toWsRpcError(cause, "Could not subscribe to sign in")),
              ),
          ),
        [WS_METHODS.providerCancelConnectionLogin]: (input) =>
          rpcEffect(
            providerConnectionLoginCoordinator.cancel(input),
            "Failed to cancel Connection sign in",
          ),
        [WS_METHODS.providerTerminateConnection]: (input) =>
          rpcEffect(
            providerConnections.getRecord(input.connectionId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new Error("The Connection is unavailable.")),
                  onSome: (connection) =>
                    Effect.gen(function* () {
                      const terminated = connection.profileRef
                        ? yield* providerConnectionLoginCoordinator.terminateProfile(input)
                        : yield* providerConnectionLifecycle.terminate(input);
                      const adapter = yield* providerAdapterRegistry.getByProvider(
                        connection.harness,
                      );
                      if (adapter.stopAccount) yield* adapter.stopAccount(input.connectionId);
                      return terminated;
                    }),
                }),
              ),
            ),
            "Failed to disconnect the Connection",
          ),
        [WS_METHODS.serverGetProviderUsageSnapshot]: (input) =>
          rpcEffect(getProviderUsageSnapshot(input), "Failed to load provider usage"),
        [WS_METHODS.serverListProviderUsage]: (input) =>
          rpcEffect(listProviderUsage(input), "Failed to load provider usage"),
        [WS_METHODS.serverTranscribeVoice]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const adapter = yield* providerAdapterRegistry.getByProvider(input.provider);
              if (!adapter.transcribeVoice) {
                return yield* Effect.fail(
                  new Error(`Voice transcription is unavailable for provider '${input.provider}'.`),
                );
              }
              const installation = (yield* providerInstallations.list()).find(
                (candidate) =>
                  candidate.harness === input.provider && candidate.lifecycle === "active",
              );
              if (!installation) {
                return yield* Effect.fail(
                  new Error("Voice transcription requires an active managed provider runtime."),
                );
              }
              const managedLaunch = yield* providerLaunchResolver.resolveProfile({
                harness: input.provider,
                connectionId: input.connectionId,
                installationId: installation.id,
                internalProviderId: null,
                nativeStateIdentity: `voice-transcription:${input.connectionId}`,
              });
              return yield* adapter.transcribeVoice({
                ...input,
                managedLaunch,
              });
            }),
            "Voice transcription failed",
          ),
        [WS_METHODS.serverUpsertKeybinding]: (input) =>
          rpcEffect(
            keybindings.upsertKeybindingRule(input).pipe(
              Effect.map((keybindingsConfig) => ({
                keybindings: keybindingsConfig,
                issues: [],
              })),
            ),
            "Failed to update keybinding",
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.lifecycle" },
            Stream.concat(
              Stream.fromEffect(
                lifecycleEvents.snapshot.pipe(
                  Effect.map((snapshot) =>
                    Array.from(snapshot.events).toSorted(
                      (left, right) => left.sequence - right.sequence,
                    ),
                  ),
                ),
              ).pipe(Stream.flatMap(Stream.fromIterable)),
              bufferLiveUiStream(lifecycleEvents.stream, {
                label: "server.lifecycle",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }),
            ).pipe(
              Stream.map(
                (event): ServerLifecycleStreamEvent =>
                  event.type === "welcome"
                    ? { type: "welcome", payload: event.payload }
                    : event.type === "ready"
                      ? { type: "ready", payload: event.payload }
                      : { type: "maintenance", payload: event.payload },
              ),
            ),
          ),
        [WS_METHODS.subscribeServerConfig]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.config" },
            Stream.concat(
              Stream.fromEffect(
                loadServerConfig.pipe(
                  Effect.map(
                    (config): ServerConfigStreamEvent => ({
                      type: "snapshot" as const,
                      config,
                    }),
                  ),
                ),
              ),
              Stream.merge(
                bufferLiveUiStream(keybindings.streamChanges, {
                  label: "server.keybindings",
                  onDroppedEvents: failLiveUiStreamForSnapshotResync,
                }).pipe(
                  Stream.map((event) => ({
                    type: "configUpdated" as const,
                    payload: { issues: event.issues, providers: [] },
                  })),
                ),
                Stream.merge(
                  bufferLiveUiStream(providerHealth.streamChanges, {
                    label: "server.provider-statuses",
                    onDroppedEvents: failLiveUiStreamForSnapshotResync,
                  }).pipe(
                    Stream.map((providers) => ({
                      type: "providerStatuses" as const,
                      payload: { providers },
                    })),
                  ),
                  bufferLiveUiStream(serverSettings.streamViews, {
                    label: "server.settings",
                    onDroppedEvents: failLiveUiStreamForSnapshotResync,
                  }).pipe(
                    Stream.map((settings) => ({
                      type: "settingsUpdated" as const,
                      payload: { settings },
                    })),
                  ),
                ),
              ),
            ).pipe(Stream.mapError((cause) => toWsRpcError(cause, "Server config stream failed"))),
          ),
        [WS_METHODS.subscribeServerProviderStatuses]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.provider-statuses" },
            Stream.concat(
              Stream.fromEffect(
                providerHealth.getStatuses.pipe(Effect.map((providers) => ({ providers }))),
              ),
              bufferLiveUiStream(providerHealth.streamChanges, {
                label: "server.provider-statuses",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }).pipe(Stream.map((providers) => ({ providers }))),
            ),
          ),
        [WS_METHODS.subscribeServerSettings]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.settings" },
            Stream.concat(
              Stream.fromEffect(
                serverSettings.getSettingsView.pipe(Effect.map((settings) => ({ settings }))),
              ),
              bufferLiveUiStream(serverSettings.streamViews, {
                label: "server.settings",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }).pipe(Stream.map((settings) => ({ settings }))),
            ).pipe(
              Stream.mapError((cause) => toWsRpcError(cause, "Server settings stream failed")),
            ),
          ),

        [WS_METHODS.providerGetComposerCapabilities]: (input) =>
          rpcEffect(
            providerDiscoveryService.getComposerCapabilities(input),
            "Failed to get composer capabilities",
          ),
        [WS_METHODS.providerGetCapabilityHealth]: (input) =>
          rpcEffect(
            providerDiscoveryService.getCapabilityHealth(input),
            "Failed to get provider capability health",
          ),
        [WS_METHODS.providerCompactThread]: (input) =>
          rpcEffect(providerService.compactThread(input), "Failed to compact thread"),
        [WS_METHODS.providerListCommands]: (input) =>
          rpcEffect(providerDiscoveryService.listCommands(input), "Failed to list commands"),
        [WS_METHODS.providerListSkills]: (input) =>
          rpcEffect(providerDiscoveryService.listSkills(input), "Failed to list skills"),
        [WS_METHODS.providerListSkillsCatalog]: (input) =>
          rpcEffect(
            Effect.tryPromise(() =>
              discoverSkillsCatalog({
                cwd: input.cwd ?? null,
                homeDir: config.homeDir,
                penkraBaseDir: config.baseDir,
                includeDuplicateOrigins: true,
              }),
            ).pipe(
              Effect.map((skills) => ({
                skills,
                penkraSkillsDir: penkraSkillsDir(config.baseDir),
              })),
            ),
            "Failed to list the skills catalog",
          ),
        [WS_METHODS.providerListPlugins]: (input) =>
          rpcEffect(providerDiscoveryService.listPlugins(input), "Failed to list plugins"),
        [WS_METHODS.providerReadPlugin]: (input) =>
          rpcEffect(providerDiscoveryService.readPlugin(input), "Failed to read plugin"),
        [WS_METHODS.providerListModels]: (input) =>
          rpcEffect(providerDiscoveryService.listModels(input), "Failed to list models"),
        [WS_METHODS.providerListAgents]: (input) =>
          rpcEffect(providerDiscoveryService.listAgents(input), "Failed to list agents"),
      });
    }),
  );

export const makeWsRpcLayer = () =>
  Layer.merge(makeWsRpcHandlersLayer(), wsRequestAdmissionMiddlewareLayer);

const makeRpcWebSocketHttpEffect = RpcServer.toHttpEffectWebsocket(AdmittedWsFeatureRpcGroup, {
  spanPrefix: "ws.rpc",
  spanAttributes: {
    "rpc.transport": "websocket",
    "rpc.system": "effect-rpc",
  },
  // JSON keeps the wire format symmetric with any web build. A serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs server and web on independently-built copies.
}).pipe(Effect.provide(makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))));

const makeBootstrapWebSocketHttpEffect = RpcServer.toHttpEffectWebsocket(WsBootstrapRpcGroup, {
  spanPrefix: "ws.bootstrap",
  spanAttributes: {
    "rpc.transport": "websocket",
    "rpc.system": "effect-rpc",
  },
}).pipe(
  Effect.provide(
    WsBootstrapRpcGroup.toLayer(
      Effect.succeed(
        WsBootstrapRpcGroup.of({
          [WS_BOOTSTRAP_METHOD]: negotiateWsCompatibility,
        }),
      ),
    ).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
  ),
);

function trustedWebSocketRequestUrl(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerConfigShape,
): URL | null {
  const url = HttpServerRequest.toURL(request);
  return url &&
    !shouldRejectUntrustedRequestOrigin({
      rawOrigin: request.headers.origin,
      requestOrigin: url.origin,
      config,
    })
    ? url
    : null;
}

export function authenticateRpcWebSocketUpgrade(input: {
  readonly config: Pick<ServerConfigShape, "authToken" | "host" | "publicUrl">;
  readonly legacyToken: string | null;
  readonly request: AuthRequest;
  readonly serverAuth: Pick<ServerAuthShape, "authenticateWebSocketUpgrade">;
}): Effect.Effect<AuthenticatedSession | null, AuthError> {
  if (
    !requiresWebSocketAuthentication(input.config) ||
    (isLoopbackHost(input.config.host) &&
      !input.config.publicUrl &&
      input.legacyToken === input.config.authToken)
  ) {
    return Effect.succeed(null);
  }
  return input.serverAuth.authenticateWebSocketUpgrade(input.request);
}

export function makeWebsocketRpcRouteLayer<R>(
  rpcWebSocketHttpEffectSource: Effect.Effect<
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >,
    never,
    R
  >,
) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const rpcWebSocketHttpEffect = yield* rpcWebSocketHttpEffectSource;
      const connectionSessions = yield* WsConnectionSessions;
      const router = yield* HttpRouter.HttpRouter;
      // RPC handlers run on fibers forked from the layer-build scope, not from
      // this per-connection fiber, so the authenticated session cannot be
      // provided as a plain service around rpcWebSocketHttpEffect. Instead the
      // session is registered for the connection's lifetime and its key is
      // injected as a synthetic upgrade header; the admission middleware
      // resolves it back into handler-scoped services on every request.
      const runWithConnectionSession = (
        request: HttpServerRequest.HttpServerRequest,
        session: WsConnectionSession,
      ) =>
        Effect.gen(function* () {
          const sessionKey = yield* connectionSessions.register(session);
          return yield* rpcWebSocketHttpEffect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({
                headers: Headers.set(request.headers, WS_CONNECTION_SESSION_HEADER, sessionKey),
              }),
            ),
          );
        });
      yield* router.add(
        "GET",
        WS_FEATURE_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const config = yield* ServerConfig;
          const serverAuth = yield* ServerAuth;
          const sessions = yield* SessionCredentialService;
          const url = trustedWebSocketRequestUrl(request, config);
          if (!url) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          const compatibilityError = validateWsFeatureCompatibility(url.searchParams);
          if (compatibilityError) {
            return HttpServerResponse.jsonUnsafe(compatibilityError, {
              status: 426,
              headers: { "Cache-Control": "no-store" },
            });
          }
          const legacyToken = url.searchParams.get("token");
          const authenticatedSession = yield* authenticateRpcWebSocketUpgrade({
            config,
            legacyToken,
            request: makeEffectAuthRequest(request),
            serverAuth,
          });

          if (!authenticatedSession) {
            return yield* runWithConnectionSession(request, {
              role: "owner",
              attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            });
          }

          return yield* sessions.runAuthenticatedConnection(
            authenticatedSession.sessionId,
            runWithConnectionSession(request, {
              role: authenticatedSession.role,
              attachmentPrincipal: attachmentPrincipalForSession(authenticatedSession.sessionId),
            }),
          );
        }).pipe(
          Effect.catchTags({
            AuthError: (error) => Effect.succeed(authErrorResponse(error)),
            SessionCapacityError: (error) =>
              Effect.succeed(
                HttpServerResponse.text(error.message, {
                  status: 429,
                  headers: {
                    "Cache-Control": "no-store",
                    "Retry-After": String(error.retryAfterSeconds),
                  },
                }),
              ),
            SessionCredentialError: (error) =>
              Effect.succeed(HttpServerResponse.text(error.message, { status: 401 })),
          }),
        ),
      );
    }),
  );
}

function makeWebsocketBootstrapRouteLayer<R>(
  bootstrapWebSocketHttpEffectSource: Effect.Effect<
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >,
    never,
    R
  >,
) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const bootstrapWebSocketHttpEffect = yield* bootstrapWebSocketHttpEffectSource;
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        WS_BOOTSTRAP_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const config = yield* ServerConfig;
          const url = trustedWebSocketRequestUrl(request, config);
          if (!url) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          return yield* bootstrapWebSocketHttpEffect;
        }),
      );
    }),
  );
}

export const websocketRpcRouteLayer = Layer.merge(
  makeWebsocketBootstrapRouteLayer(makeBootstrapWebSocketHttpEffect),
  // The registry must be provided here so the upgrade route and the RPC
  // middleware (built from the same source effect) share one instance.
  makeWebsocketRpcRouteLayer(makeRpcWebSocketHttpEffect).pipe(
    Layer.provide(WsConnectionSessionsLive),
  ),
);

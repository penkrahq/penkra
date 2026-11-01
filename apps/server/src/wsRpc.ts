import { ModelSelection } from "@penkra/contracts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ProviderAuthCircuits } from "./provider/providerAuthCircuit.ts";
import { PLAY_TURN_RECOVERY_PROMPT } from "./cleanCore/sendMessage.ts";
import { getNavigation, updateNavigation } from "./cleanCore/navigation";
import { getBootstrap } from "./cleanCore/bootstrap";
import { getFolderAppTabs, updateFolderAppTabs } from "./cleanCore/folderAppTabs.ts";
import { listArchivedNavigation, listArchivedThreads, restoreThread } from "./cleanCore/archive.ts";
import {} from "./scratchWorkspaces.ts";
import { createAndSendThread } from "./cleanCore/createAndSendThread.ts";
import { createThreadFromClient, ThreadLifecycle } from "./cleanCore/threadLifecycle.ts";
import { ThreadSender } from "./cleanCore/ThreadSender.ts";

import { SavedRestoreDraftNotEmptyError, SavedPromptDraftChangedError } from "@penkra/contracts";
import {
  ORCHESTRATION_WS_METHODS,
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_FEATURE_PATH,
  WS_METHODS,
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsRpcError,
  QueuedEditDraftNotEmptyError,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
} from "@penkra/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema, Scope, Stream } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcServer } from "effect/rpc";
import { observedRpcJsonLayer } from "./rpcMessageSizes";
import * as SqlClient from "effect/sql/SqlClient";

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
import { createLocalPreviewGrant } from "./localImageFiles";
import {
  attachmentPrincipalForSession,
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
} from "./managedAttachmentPrincipal";
import { Open, resolveAvailableEditors } from "./open";
import { makeImportThreadHandler } from "./orchestration/importThreadRoute";
import {} from "./orchestration/Services/ProviderThreadSwitchCoordinator";
import { ThreadReads } from "./cleanCore/ThreadReads";
import { listProviderConnectionManifests } from "./provider/providerConnectionManifests";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderCatalogService } from "./provider/Services/ProviderCatalog.ts";
import { discoverSkillsCatalog, penkraSkillsDir } from "./provider/skillsCatalog";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderConnectionLifecycle } from "./provider/Services/ProviderConnectionLifecycle";
import { ProviderConnectionLoginCoordinator } from "./provider/Services/ProviderConnectionLoginCoordinator";
import { ProviderLaunchResolver } from "./provider/Services/ProviderLaunchResolver";
import { ProviderConnectionRepository } from "./persistence/Services/ProviderConnections";
import { ProviderInstallationRepository } from "./persistence/Services/ProviderInstallations";
import { ProviderUsage } from "./providerUsage/ProviderUsage.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { isLoopbackHost } from "./startupAccess";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { makeWsStreamAdmission } from "./wsStreamAdmission";
import { listThreadItemsPage, listTurnItems } from "./cleanCore/threadItemsPage.ts";
import { getMessageAdmission } from "./cleanCore/messageAdmission.ts";
import { findThread, listThreads, searchThreads } from "./cleanCore/threadList.ts";
import { getThreadDraft, setThreadDraft } from "./cleanCore/threadDraft.ts";
import {
  markThreadVisited,
  moveSidebarItem,
  setThreadRuntimeMode,
} from "./cleanCore/threadStore.ts";
import { ThreadPublisher } from "./cleanCore/ThreadPublisher.ts";
import { sidebarChangeStream, threadChangeStream } from "./cleanCore/threadChangeStream.ts";
import { recoverMissingFile } from "./missingFileRecovery";
import { WorkspaceWatcher } from "./workspaceWatcher";
import { RemotePairingControl, answerPairing, pairingChanges } from "./remoteLink/pairingControl";
import {
  RemoteDevicesControl,
  ownerDevices,
  ownerRemoveDevice,
  ownerDeviceChanges,
} from "./remoteLink/devicesControl";
import {
  CurrentWsConnection,
  originForWsConnection,
  provideWsConnectionSession,
  WsConnectionSessionMiddleware,
  WsConnectionSessionMiddlewareLive,
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
import {} from "./wsSyncAcknowledgements";
import { wsRpcErrorCode } from "./wsRpcErrorMapping";
import { findThreadPolicyError } from "./cleanCore/threadErrors.ts";
import { getRendererCredential } from "./rendererCredential";

export function isRendererToken(
  candidate: string | null,
  token = getRendererCredential(),
): boolean {
  if (!candidate || !token) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const isPairedPhoneSession = (sessionId: string, subject: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ sessionId: string }>`SELECT session_id AS "sessionId"
      FROM remote_devices WHERE session_id=${sessionId} AND device_id=${subject} LIMIT 1`;
    return rows.length > 0;
  });

const SessionScopedWsFeatureRpcGroup = WsFeatureRpcGroup.middleware(WsConnectionSessionMiddleware);

// Relative subdirectories scaffolded under a freshly created chat container workspace root.
const CHAT_WORKSPACE_SUBDIRECTORIES = ["work", "outputs"] as const;

function toWsRpcError(cause: unknown, fallbackMessage: string) {
  const code = wsRpcErrorCode(cause);
  const threadGuard = findThreadPolicyError(cause);
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

const makeWsRpcHandlersLayer = () =>
  SessionScopedWsFeatureRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const open = yield* Open;
      const path = yield* Path.Path;
      const projectionReadModelQuery = yield* ThreadReads;
      const providerAdapterRegistry = yield* ProviderAdapterRegistry;
      const providerDiscoveryService = yield* ProviderDiscoveryService;
      const providerCatalog = yield* ProviderCatalogService;
      const authCircuits = yield* ProviderAuthCircuits;
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
      const pairing = yield* RemotePairingControl;
      const remoteDevices = yield* RemoteDevicesControl;
      const sql = yield* SqlClient.SqlClient;
      const threadPublisher = yield* ThreadPublisher;
      const providerUsage = yield* ProviderUsage;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const workspaceWatcher = yield* WorkspaceWatcher;
      const streamAdmission = yield* makeWsStreamAdmission();

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

      const importThread = makeImportThreadHandler({
        projectionSnapshotQuery: projectionReadModelQuery,
      });

      const loadServerConfig = Effect.gen(function* () {
        const providerStatuses = yield* providerHealth.getStatuses;
        return {
          cwd: config.cwd,
          homeDir: config.homeDir,
          chatWorkspaceRoot: config.chatWorkspaceRoot,
          providers: providerStatuses,
          availableEditors: resolveAvailableEditors(),
        };
      });

      const rpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
        effect.pipe(Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)));

      return SessionScopedWsFeatureRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.importThread]: (input) =>
          rpcEffect(importThread(input), "Failed to import thread"),

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
        [WS_METHODS.subscribeProjectWorkspaceChanges]: (_, { client: { id: clientId } }) =>
          streamAdmission.guard(
            clientId,
            { key: "folders.workspace-changes" },
            workspaceWatcher.stream,
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
              Effect.gen(function* () {
                const connection = yield* CurrentWsConnection;
                const sender = yield* ThreadSender;
                const origin = originForWsConnection(connection.connectionClass);
                const result = yield* sender.send({
                  ...input,
                  message: { ...input.message, origin },
                });
                yield* Effect.logInfo("Accepted WebSocket send", connection);
                return result;
              }),
            ),
            "Failed to send the message",
          ),
        [WS_METHODS.cleanCoreSteerQueued]: (input) =>
          rpcEffect(
            runtimeStartup.enqueueCommand(
              Effect.gen(function* () {
                const connection = yield* CurrentWsConnection;
                const sender = yield* ThreadSender;
                const origin = originForWsConnection(connection.connectionClass);
                const result = yield* sender.steerQueued(input, undefined, origin);
                yield* Effect.logInfo("Accepted WebSocket steer", connection);
                return result;
              }),
            ),
            "Failed to steer the queued message",
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
        [WS_METHODS.cleanCoreGetBootstrap]: () =>
          rpcEffect(getBootstrap, "Failed to load startup state"),
        [WS_METHODS.cleanCoreSavePrompt]: (input) =>
          Effect.flatMap(Effect.service(ThreadSender), (sender) => sender.savePrompt(input)).pipe(
            Effect.map((result) => ({ ...result, messageId: input.message.messageId })),
            Effect.mapError((error) =>
              Schema.is(SavedPromptDraftChangedError)(error)
                ? error
                : toWsRpcError(error, "Failed to save prompt"),
            ),
          ),
        [WS_METHODS.cleanCoreDeleteSavedPrompt]: (input) =>
          rpcEffect(
            Effect.flatMap(Effect.service(ThreadSender), (sender) =>
              sender.deleteSavedPrompt(input),
            ).pipe(Effect.map((result) => ({ ...result, messageId: input.messageId }))),
            "Failed to delete saved prompt",
          ),
        [WS_METHODS.cleanCoreRestoreSavedPrompt]: (input) =>
          Effect.flatMap(Effect.service(ThreadSender), (sender) =>
            sender.restoreSavedPrompt(input),
          ).pipe(
            Effect.map((result) => ({ ...result, messageId: input.messageId })),
            Effect.mapError((error) =>
              Schema.is(SavedRestoreDraftNotEmptyError)(error)
                ? error
                : toWsRpcError(error, "Failed to restore saved prompt"),
            ),
          ),
        [WS_METHODS.cleanCoreGetNavigation]: () =>
          rpcEffect(getNavigation, "Failed to read navigation"),
        [WS_METHODS.cleanCoreUpdateNavigation]: (input) =>
          rpcEffect(updateNavigation(input), "Failed to update navigation"),
        [WS_METHODS.cleanCoreGetFolders]: (input) =>
          rpcEffect(
            projectionReadModelQuery.getFolderShellsByIds(input.folderIds),
            "Failed to read folders",
          ),
        [WS_METHODS.cleanCoreGetThreadShell]: (input) =>
          rpcEffect(
            Effect.flatMap(Effect.service(ThreadReads), (query) =>
              query.getThreadShellById(input.threadId).pipe(Effect.map(Option.getOrNull)),
            ),
            "Failed to read the thread shell",
          ),
        [WS_METHODS.cleanCoreCreateAndSendThread]: (input) =>
          rpcEffect(
            runtimeStartup.enqueueCommand(
              Effect.gen(function* () {
                const connection = yield* CurrentWsConnection;
                const origin = originForWsConnection(connection.connectionClass);
                const result = yield* createAndSendThread(input, origin);
                yield* Effect.logInfo("Accepted WebSocket create and send", connection);
                const query = yield* ThreadReads;
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
              const query = yield* ThreadReads;
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
                case "stopTask":
                  yield* providerService.stopTask({
                    threadId: update.threadId,
                    taskId: update.taskId,
                  });
                  return;
                case "resume": {
                  const row = yield* findThread(update.threadId);
                  if (row === null)
                    return yield* Effect.fail(new Error("The thread does not exist."));
                  const sender = yield* ThreadSender;
                  yield* sender.send({
                    threadId: update.threadId,
                    message: {
                      messageId: update.messageId,
                      text: PLAY_TURN_RECOVERY_PROMPT,
                      attachments: [],
                      origin: { _tag: "recovery" as const },
                      queuedAt: update.updatedAt,
                    },
                    dispatchMode: "queue",
                    modelSelection: Schema.decodeUnknownSync(ModelSelection)({
                      provider: row.provider,
                      model: row.model,
                      ...(row.modelOptions === null
                        ? {}
                        : { options: JSON.parse(row.modelOptions) }),
                    }),
                    connectionId: row.connectionId,
                    ...(update.runtimeMode === undefined
                      ? {}
                      : { runtimeMode: update.runtimeMode }),
                  });
                  return;
                }
                case "rename":
                case "archive":
                case "delete":
                  yield* Effect.flatMap(Effect.service(ThreadLifecycle), (lifecycle) =>
                    lifecycle.update(update),
                  );
                  return;
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
        [WS_METHODS.cleanCoreListTurnItems]: (input) =>
          rpcEffect(listTurnItems(input), "Failed to load turn details"),
        [WS_METHODS.cleanCoreGetThreadDraft]: (input) =>
          rpcEffect(getThreadDraft(input.threadId), "Failed to load the thread draft"),
        [WS_METHODS.cleanCoreGetMessageAdmission]: (input) =>
          rpcEffect(getMessageAdmission(input), "Failed to check message admission"),
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
        [WS_METHODS.remoteAnswerPairing]: (input) =>
          answerPairing(pairing, input.requestId, input.allow),
        [WS_METHODS.remoteListDevices]: () => ownerDevices(remoteDevices),
        [WS_METHODS.remoteRemoveDevice]: (input) =>
          ownerRemoveDevice(remoteDevices, input.deviceId),
        [WS_METHODS.remoteSubscribeDevices]: (_, { client: { id: clientId } }) =>
          streamAdmission.guard(
            clientId,
            { key: "remote.devices" },
            ownerDeviceChanges(remoteDevices).pipe(Stream.map(() => ({}))),
          ),
        [WS_METHODS.remoteSubscribePairing]: (_, { client: { id: clientId } }) =>
          streamAdmission.guard(clientId, { key: "remote.pairing" }, pairingChanges(pairing)),
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
            Effect.gen(function* () {
              const circuit = (yield* authCircuits.get(input.connectionId))[0];
              if (!circuit) return;
              const accepted = yield* providerDiscoveryService
                .probeConnection({ provider: circuit.harness, connectionId: input.connectionId })
                .pipe(Effect.catch(() => Effect.succeed(false)));
              if (accepted) yield* authCircuits.close(input.connectionId);
              else yield* authCircuits.recordFailedProbe(input.connectionId);
            }),
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
        [WS_METHODS.providerSubscribeConnectionLogin]: (input, { client: { id: clientId } }) =>
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
                      yield* providerService.stopConnection(input.connectionId, connection.harness);
                      return terminated;
                    }),
                }),
              ),
            ),
            "Failed to disconnect the Connection",
          ),
        [WS_METHODS.serverListProviderUsage]: (input) =>
          rpcEffect(
            providerUsage.snapshot.pipe(
              Effect.map((snapshots) =>
                snapshots.filter(
                  (snapshot) =>
                    snapshot.connectionId !== undefined &&
                    input.connectionIds.includes(snapshot.connectionId) &&
                    (input.provider === undefined || input.provider === snapshot.provider),
                ),
              ),
            ),
            "Failed to read provider usage",
          ),
        [WS_METHODS.serverSubscribeProviderUsage]: (_, { client: { id: clientId } }) =>
          streamAdmission.guard(clientId, { key: "server.providerUsage" }, providerUsage.changes),
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
        [WS_METHODS.subscribeServerLifecycle]: (_, { client: { id: clientId } }) =>
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
        [WS_METHODS.subscribeServerConfig]: (_, { client: { id: clientId } }) =>
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
              ).pipe(
                Stream.merge(
                  providerCatalog.streamChanges.pipe(
                    Stream.map((event) => ({
                      type: "catalog.changed" as const,
                      scope: event.scope,
                      version: event.version,
                    })),
                  ),
                ),
              ),
            ).pipe(Stream.mapError((cause) => toWsRpcError(cause, "Server config stream failed"))),
          ),
        [WS_METHODS.subscribeServerProviderStatuses]: (_, { client: { id: clientId } }) =>
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
        [WS_METHODS.subscribeServerSettings]: (_, { client: { id: clientId } }) =>
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
        [WS_METHODS.providerGetCatalog]: ({ kinds, ...scope }) =>
          rpcEffect(providerCatalog.get(scope, kinds), "Failed to read the provider catalog"),
        [WS_METHODS.providerReloadCatalog]: (scope) =>
          rpcEffect(providerCatalog.reload(scope), "Failed to retry the provider catalog"),
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
      });
    }),
  );

export const makeWsRpcLayer = () =>
  Layer.merge(makeWsRpcHandlersLayer(), WsConnectionSessionMiddlewareLive);

const makeRpcWebSocketHttpEffect = RpcServer.toHttpEffectWebsocket(SessionScopedWsFeatureRpcGroup, {
  spanPrefix: "ws.rpc",
  spanAttributes: {
    "rpc.transport": "websocket",
    "rpc.system": "effect-rpc",
  },
  // JSON keeps the wire format symmetric with any web build. A serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs server and web on independently-built copies.
}).pipe(
  Effect.provide(
    makeWsRpcLayer().pipe(
      Layer.provideMerge(
        observedRpcJsonLayer(new Set(SessionScopedWsFeatureRpcGroup.requests.keys())),
      ),
    ),
  ),
);

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
    ).pipe(Layer.provideMerge(observedRpcJsonLayer(new Set(WsBootstrapRpcGroup.requests.keys())))),
  ),
);

function trustedWebSocketRequestUrl(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerConfigShape,
): URL | null {
  const url = Option.getOrUndefined(HttpServerRequest.toURL(request));
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
  readonly rendererToken?: string | null;
  readonly request: AuthRequest;
  readonly serverAuth: Pick<ServerAuthShape, "authenticateWebSocketUpgrade">;
}): Effect.Effect<AuthenticatedSession | null, AuthError> {
  if (
    !requiresWebSocketAuthentication(input.config) ||
    (isLoopbackHost(input.config.host) &&
      !input.config.publicUrl &&
      (input.legacyToken === input.config.authToken ||
        isRendererToken(input.rendererToken ?? null)))
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
          const rendererAuthenticated =
            isLoopbackHost(config.host) &&
            !config.publicUrl &&
            isRendererToken(url.searchParams.get("rendererToken"));
          const authenticatedSession = yield* authenticateRpcWebSocketUpgrade({
            config,
            legacyToken,
            rendererToken: url.searchParams.get("rendererToken"),
            request: makeEffectAuthRequest(request),
            serverAuth,
          });

          if (!authenticatedSession) {
            return yield* runWithConnectionSession(request, {
              role: "owner",
              attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
              connectionClass: rendererAuthenticated ? "renderer" : "external",
              sessionId: randomUUID(),
            });
          }

          // Only sessions bound to a trusted paired phone get phone attribution;
          // other bearer and browser sessions are external clients.
          const paired = yield* isPairedPhoneSession(
            authenticatedSession.sessionId,
            authenticatedSession.subject,
          );

          return yield* sessions.runAuthenticatedConnection(
            authenticatedSession.sessionId,
            runWithConnectionSession(request, {
              role: authenticatedSession.role,
              attachmentPrincipal: attachmentPrincipalForSession(authenticatedSession.sessionId),
              connectionClass: paired ? "phone" : "external",
              sessionId: authenticatedSession.sessionId,
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

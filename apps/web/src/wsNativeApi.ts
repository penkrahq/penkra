// FILE: wsNativeApi.ts
// Purpose: NativeApi implementation backed by the browser WebSocket RPC transport.
// Layer: Web transport adapter
// Exports: createWsNativeApi and event subscription helpers for server push channels.

import {
  type AuthBearerBootstrapResult,
  type AuthBootstrapInput,
  type AuthBootstrapResult,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthLogoutResult,
  type AuthPairingCredentialResult,
  type AuthPairingLink,
  type AuthRevokeClientSessionInput,
  type AuthRevokePairingLinkInput,
  type AuthSessionState,
  type AuthWebSocketTokenResult,
  type CleanCoreThreadChange,
  type CleanCoreSidebarChange,
  type ProjectWorkspaceChangeEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerLifecycleStreamEvent,
  type ServerSettingsUpdatedPayload,
  type ServerVoiceTranscriptionResult,
  CLEAN_CORE_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  WS_CHANNELS,
  WS_METHODS,
  type WsWelcomePayload,
} from "@penkra/contracts";
import { VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH } from "@penkra/shared/binaryTransfer";

import { showConfirmDialogFallback } from "./confirmDialogFallback";
import { showContextMenuFallback } from "./contextMenuFallback";
import { requireHttpExternalUrl } from "./lib/externalUrl";
import { WsTransport, type WsThreadStreamFailure } from "./wsTransport";
import { emitWsCompatibilityIssue, emitWsTransportState } from "./wsTransportEvents";
import { resolveWsHttpUrl } from "./lib/wsHttpUrl";

export type { WsThreadStreamFailure } from "./wsTransport";

let instance: { api: NativeApi; transport: WsTransport } | null = null;

function createListenerRegistry<T>() {
  const listeners = new Set<(payload: T) => void>();
  return {
    get size() {
      return listeners.size;
    },
    subscribe(listener: (payload: T) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(payload: T) {
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch {
          // A listener must not prevent delivery to the remaining subscribers.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

function subscribeWithReplay<T>(input: {
  readonly registry: {
    subscribe: (listener: (payload: T) => void) => () => unknown;
  };
  readonly listener: (payload: T) => void;
  readonly latest: T | null;
}): () => void {
  const unsubscribe = input.registry.subscribe(input.listener);
  if (input.latest) {
    try {
      input.listener(input.latest);
    } catch {
      // Replay follows the same listener isolation as live delivery.
    }
  }
  return () => void unsubscribe();
}

const welcomeListeners = createListenerRegistry<WsWelcomePayload>();
const serverConfigUpdatedListeners = createListenerRegistry<ServerConfigUpdatedPayload>();
const serverProviderStatusesUpdatedListeners =
  createListenerRegistry<ServerProviderStatusesUpdatedPayload>();
const serverMaintenanceUpdatedListeners = createListenerRegistry<ServerLifecycleStreamEvent>();
const serverSettingsUpdatedListeners = createListenerRegistry<ServerSettingsUpdatedPayload>();
const projectWorkspaceChangeListeners = createListenerRegistry<ProjectWorkspaceChangeEvent>();
const cleanCoreSidebarChangeListeners = createListenerRegistry<CleanCoreSidebarChange>();
const cleanCoreThreadChangeListeners = createListenerRegistry<CleanCoreThreadChange>();
const threadStreamFailureListeners = createListenerRegistry<WsThreadStreamFailure>();

function clearWsNativeApiListeners(): void {
  cleanCoreSidebarChangeListeners.clear();
  welcomeListeners.clear();
  serverConfigUpdatedListeners.clear();
  serverProviderStatusesUpdatedListeners.clear();
  serverMaintenanceUpdatedListeners.clear();
  serverSettingsUpdatedListeners.clear();
  projectWorkspaceChangeListeners.clear();
  threadStreamFailureListeners.clear();
}

async function requestAuthJson<T>(
  path: string,
  options: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
  } = {},
): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    ...(hasBody
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }
      : {}),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Auth request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function requestVoiceTranscriptionUpload(
  input: Parameters<NativeApi["server"]["transcribeVoice"]>[0],
) {
  const desktopTranscription = window.desktopBridge?.voice?.transcribeWithServer;
  if (desktopTranscription) {
    return desktopTranscription(input);
  }
  const params = new URLSearchParams({
    provider: input.provider,
    connectionId: input.connectionId,
    cwd: input.cwd,
    mimeType: input.mimeType,
    sampleRateHz: String(input.sampleRateHz),
    durationMs: String(input.durationMs),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
  const decoded = atob(input.audioBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  const audioBody = new Blob([bytes], { type: input.mimeType });
  const response = await fetch(
    resolveWsHttpUrl(`${VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH}?${params.toString()}`),
    { method: "POST", credentials: "include", body: audioBody },
  );
  const payload = (await response.json().catch(() => null)) as
    | ServerVoiceTranscriptionResult
    | { readonly error?: unknown }
    | null;
  if (!response.ok || !payload || !("text" in payload)) {
    const message =
      payload && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Voice transcription failed with status ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  const latestWelcome = instance?.transport.getLatestPush(WS_CHANNELS.serverWelcome)?.data ?? null;
  return subscribeWithReplay({ registry: welcomeListeners, listener, latest: latestWelcome });
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  const latestConfig =
    instance?.transport.getLatestPush(WS_CHANNELS.serverConfigUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverConfigUpdatedListeners,
    listener,
    latest: latestConfig,
  });
}

/**
 * Subscribe to provider status updates without forcing a full config reload.
 */
export function onServerProviderStatusesUpdated(
  listener: (payload: ServerProviderStatusesUpdatedPayload) => void,
): () => void {
  const latestProviderStatuses =
    instance?.transport.getLatestPush(WS_CHANNELS.serverProviderStatusesUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverProviderStatusesUpdatedListeners,
    listener,
    latest: latestProviderStatuses,
  });
}

export function onServerMaintenanceUpdated(
  listener: (payload: ServerLifecycleStreamEvent) => void,
): () => void {
  const latestMaintenance =
    instance?.transport.getLatestPush(WS_CHANNELS.serverMaintenanceUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverMaintenanceUpdatedListeners,
    listener,
    latest: latestMaintenance,
  });
}

export function onServerSettingsUpdated(
  listener: (payload: ServerSettingsUpdatedPayload) => void,
): () => void {
  const latestSettings =
    instance?.transport.getLatestPush(WS_CHANNELS.serverSettingsUpdated)?.data ?? null;
  return subscribeWithReplay({
    registry: serverSettingsUpdatedListeners,
    listener,
    latest: latestSettings,
  });
}

/**
 * Subscribe to unrecoverable per-thread stream failures (retries and reconnect
 * exhausted). Lets thread-detail consumers surface a failed hydration state
 * instead of rendering an empty conversation.
 */
export function onThreadStreamFailure(
  listener: (failure: WsThreadStreamFailure) => void,
): () => void {
  const unsubscribe = threadStreamFailureListeners.subscribe(listener);
  return () => void unsubscribe();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    if (instance.transport.getState() !== "disposed") {
      return instance.api;
    }
    instance = null;
  }

  const transport = new WsTransport();
  transport.onStateChange((state) => emitWsTransportState(state));
  transport.onCompatibilityIssue((issue) => emitWsCompatibilityIssue(issue), {
    replayCurrent: true,
  });

  transport.subscribe(WS_CHANNELS.serverWelcome, (message) => {
    welcomeListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverConfigUpdated, (message) => {
    serverConfigUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverProviderStatusesUpdated, (message) => {
    serverProviderStatusesUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverMaintenanceUpdated, (message) => {
    serverMaintenanceUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.serverSettingsUpdated, (message) => {
    serverSettingsUpdatedListeners.emit(message.data);
  });
  transport.subscribe(WS_CHANNELS.projectWorkspaceChange, (message) => {
    projectWorkspaceChangeListeners.emit(message.data);
  });
  transport.subscribe(CLEAN_CORE_WS_CHANNELS.sidebarChange, (message) => {
    cleanCoreSidebarChangeListeners.emit(message.data);
  });
  transport.subscribe(CLEAN_CORE_WS_CHANNELS.threadChange, (message) => {
    cleanCoreThreadChangeListeners.emit(message.data);
  });
  transport.onThreadStreamFailure((failure) => {
    threadStreamFailureListeners.emit(failure);
  });
  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      ...(window.desktopBridge?.pickImage
        ? { pickImage: () => window.desktopBridge!.pickImage!() }
        : {}),
      saveFile: async (input) => {
        if (window.desktopBridge?.saveFile) {
          return window.desktopBridge.saveFile(input);
        }
        const blob = new Blob([input.contents], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = input.defaultFilename;
          anchor.click();
        } finally {
          URL.revokeObjectURL(url);
        }
        return null;
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return showConfirmDialogFallback(message);
      },
    },
    folders: {
      listDirectories: (input) => transport.request(WS_METHODS.projectsListDirectories, input),
      searchEntries: (input) => transport.request(WS_METHODS.projectsSearchEntries, input),
      searchLocalEntries: (input) =>
        transport.request(WS_METHODS.projectsSearchLocalEntries, input),
      readFile: (input) => transport.request(WS_METHODS.projectsReadFile, input),
      createLocalFilePreviewGrant: (input) =>
        transport.request(WS_METHODS.projectsCreateLocalFilePreviewGrant, input),
      writeFile: (input) => transport.request(WS_METHODS.projectsWriteFile, input),
      onWorkspaceChange: projectWorkspaceChangeListeners.subscribe,
    },
    filesystem: {
      browse: (input) => transport.request(WS_METHODS.filesystemBrowse, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        transport.request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      openExternal: async (url) => {
        const externalUrl = requireHttpExternalUrl(url);
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(externalUrl);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        // Some mobile browsers can return null here even when the tab opens.
        // Avoid false negatives and let the browser handle popup policy.
        window.open(externalUrl, "_blank", "noopener,noreferrer");
      },
      showInFolder: async (path) => {
        if (window.desktopBridge) {
          await window.desktopBridge.showInFolder(path);
        }
        // No-op in browser - this is a desktop-only feature
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position);
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => transport.request(WS_METHODS.serverGetConfig),
      getEnvironment: () => transport.request(WS_METHODS.serverGetEnvironment),
      getSettings: () => transport.request(WS_METHODS.serverGetSettings),
      updateSettings: (input) => transport.request(WS_METHODS.serverUpdateSettings, input),
      getSpaceNavigationState: () => transport.request(WS_METHODS.serverGetSpaceNavigationState),
      updateSpaceNavigationState: (input) =>
        transport.request(WS_METHODS.serverUpdateSpaceNavigationState, input),
      getAuthSession: () => requestAuthJson<AuthSessionState>("/api/auth/session"),
      bootstrapAuth: (input: AuthBootstrapInput) =>
        requestAuthJson<AuthBootstrapResult>("/api/auth/bootstrap", {
          method: "POST",
          body: input,
        }),
      bootstrapBearerAuth: (input: AuthBootstrapInput) =>
        requestAuthJson<AuthBearerBootstrapResult>("/api/auth/bootstrap/bearer", {
          method: "POST",
          body: input,
        }),
      issueAuthWebSocketToken: () =>
        requestAuthJson<AuthWebSocketTokenResult>("/api/auth/ws-token", { method: "POST" }),
      createAuthPairingToken: (input?: AuthCreatePairingCredentialInput) =>
        requestAuthJson<AuthPairingCredentialResult>("/api/auth/pairing-token", {
          method: "POST",
          ...(input ? { body: input } : {}),
        }),
      listAuthPairingLinks: () =>
        requestAuthJson<ReadonlyArray<AuthPairingLink>>("/api/auth/pairing-links"),
      revokeAuthPairingLink: (input: AuthRevokePairingLinkInput) =>
        requestAuthJson<{ revoked: boolean }>("/api/auth/pairing-links/revoke", {
          method: "POST",
          body: input,
        }),
      listAuthClients: () => requestAuthJson<ReadonlyArray<AuthClientSession>>("/api/auth/clients"),
      revokeAuthClient: (input: AuthRevokeClientSessionInput) =>
        requestAuthJson<{ revoked: boolean }>("/api/auth/clients/revoke", {
          method: "POST",
          body: input,
        }),
      revokeOtherAuthClients: () =>
        requestAuthJson<{ revokedCount: number }>("/api/auth/clients/revoke-others", {
          method: "POST",
        }),
      logoutAuthSession: async () => {
        const result = await requestAuthJson<AuthLogoutResult>("/api/auth/logout", {
          method: "POST",
        });
        await transport.dispose();
        return result;
      },
      refreshProviders: () => transport.request(WS_METHODS.serverRefreshProviders),
      listProviderUsage: (input) => transport.request(WS_METHODS.serverListProviderUsage, input),
      transcribeVoice: requestVoiceTranscriptionUpload,
    },
    provider: {
      getComposerCapabilities: (input) =>
        transport.request(WS_METHODS.providerGetComposerCapabilities, input),
      getCapabilityHealth: (input) =>
        transport.request(WS_METHODS.providerGetCapabilityHealth, input),
      // Compaction is capped server-side per provider (ACP providers allow up
      // to the 10-minute turn-idle ceiling), so the server owns this bound.
      compactThread: (input) =>
        transport.request(WS_METHODS.providerCompactThread, input, { timeoutMs: null }),
      listCommands: (input) => transport.request(WS_METHODS.providerListCommands, input),
      listSkills: (input) => transport.request(WS_METHODS.providerListSkills, input),
      listSkillsCatalog: (input) => transport.request(WS_METHODS.providerListSkillsCatalog, input),
      listPlugins: (input) => transport.request(WS_METHODS.providerListPlugins, input),
      readPlugin: (input) => transport.request(WS_METHODS.providerReadPlugin, input),
      listModels: (input) => transport.request(WS_METHODS.providerListModels, input),
      listAgents: (input) => transport.request(WS_METHODS.providerListAgents, input),
      getConnections: (input = {}) => transport.request(WS_METHODS.providerGetConnections, input),
      retryAuthConnection: (input) =>
        transport.request(WS_METHODS.providerRetryAuthConnection, input),
      createStaticConnection: (input) =>
        transport.request(WS_METHODS.providerCreateStaticConnection, input),
      beginConnectionLogin: (input) =>
        transport.request(WS_METHODS.providerBeginConnectionLogin, input),
      subscribeConnectionLogin: (input, onSnapshot, onError) =>
        transport.subscribeConnectionLogin(input, onSnapshot, onError),
      cancelConnectionLogin: (input) =>
        transport.request(WS_METHODS.providerCancelConnectionLogin, input),
      terminateConnection: (input) =>
        transport.request(WS_METHODS.providerTerminateConnection, input),
    },
    cleanCore: {
      listArchivedNavigation: () =>
        transport.request(WS_METHODS.cleanCoreListArchivedNavigation, {}),
      listArchivedThreads: (input) =>
        transport.request(WS_METHODS.cleanCoreListArchivedThreads, input),
      restoreThread: (input) => transport.request(WS_METHODS.cleanCoreRestoreThread, input),
      getNavigation: () => transport.request(WS_METHODS.cleanCoreGetNavigation),
      getBootstrap: () => transport.request(WS_METHODS.cleanCoreGetBootstrap),
      updateNavigation: (input) => transport.request(WS_METHODS.cleanCoreUpdateNavigation, input),
      getFolders: (input) => transport.request(WS_METHODS.cleanCoreGetFolders, input),
      getThread: (input) => transport.request(WS_METHODS.cleanCoreGetThread, input),
      sendMessage: (input) => transport.request(WS_METHODS.cleanCoreSendMessage, input),
      steerQueued: (input) => transport.request(WS_METHODS.cleanCoreSteerQueued, input),
      cancelQueuedMessage: (input) =>
        transport.request(WS_METHODS.cleanCoreCancelQueuedMessage, input),
      editQueuedMessage: (input) => transport.request(WS_METHODS.cleanCoreEditQueuedMessage, input),
      getThreadShell: (input) => transport.request(WS_METHODS.cleanCoreGetThreadShell, input),
      getFolderAppTabs: (input) => transport.request(WS_METHODS.cleanCoreGetFolderAppTabs, input),
      updateFolderAppTabs: (input) =>
        transport.request(WS_METHODS.cleanCoreUpdateFolderAppTabs, input),
      createThread: (input) => transport.request(WS_METHODS.cleanCoreCreateThread, input),
      createAndSendThread: (input) =>
        transport.request(WS_METHODS.cleanCoreCreateAndSendThread, input),
      getThreadRuntime: (input) => transport.request(WS_METHODS.cleanCoreGetThreadRuntime, input),
      interruptThread: (input) => transport.request(WS_METHODS.cleanCoreInterruptThread, input),
      searchThreads: (input) => transport.request(WS_METHODS.cleanCoreSearchThreads, input),
      listThreads: (input) => transport.request(WS_METHODS.cleanCoreListThreads, input),
      updateThread: (input) => transport.request(WS_METHODS.cleanCoreUpdateThread, input),
      listThreadItemsPage: (input) =>
        transport.request(WS_METHODS.cleanCoreListThreadItemsPage, input),
      listTurnItems: (input) => transport.request(WS_METHODS.cleanCoreListTurnItems, input),
      getThreadDraft: (input) => transport.request(WS_METHODS.cleanCoreGetThreadDraft, input),
      setThreadDraft: (input) => transport.request(WS_METHODS.cleanCoreSetThreadDraft, input),
      subscribeThread: (input) => transport.request(WS_METHODS.cleanCoreSubscribeThread, input),
      unsubscribeThread: (input) => {
        transport.stopCleanCoreThreadStream(input.threadId);
        return Promise.resolve();
      },
      answerThreadQuestion: (input) =>
        transport.request(WS_METHODS.cleanCoreAnswerThreadQuestion, input),
      onThreadChange: cleanCoreThreadChangeListeners.subscribe,
      onSidebarChange: cleanCoreSidebarChangeListeners.subscribe,
    },
    orchestration: {
      importThread: (input) => transport.request(ORCHESTRATION_WS_METHODS.importThread, input),
    },
  };

  instance = { api, transport };
  return api;
}

// Browser-mode tests mount full app roots repeatedly in one page; reset the
// singleton so each test gets a fresh WebSocket stream and cached push state.
export async function resetWsNativeApiForTest(): Promise<void> {
  const transport = instance?.transport;
  instance = null;
  clearWsNativeApiListeners();
  await transport?.dispose();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void instance?.transport.dispose();
    instance = null;
    clearWsNativeApiListeners();
  });
}

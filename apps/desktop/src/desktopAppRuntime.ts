// FILE: desktopAppRuntime.ts
// Purpose: Composes trusted App persistence, isolation, controller, broker, and IPC services.
// Layer: Desktop main-process bootstrap

import {
  app,
  safeStorage,
  webContents,
  type BrowserWindow,
  type IpcMain,
  type WebContents,
} from "electron";
import type { DesktopAppTabClosed, DesktopAppTabDescriptor } from "@penkra/contracts";

import { AppControllerHost } from "./appControllerHost";
import { AppInstallationStore, resolveAppInstallationStatePath } from "./appInstallationStore";
import { AppInstallationService } from "./appInstallationService";
import {
  AppPackageIngestor,
  resolveAppPackageStorePath,
  type AppPackageGarbageCollectionResult,
} from "./appPackageIngestor";
import { AppOperationBroker } from "./appOperationBroker";
import { AppOperationCatalog } from "./appOperationCatalog";
import { AppIntentRouter } from "./appIntentRouter";
import {
  AppOpenWithPreferenceStore,
  resolveAppOpenWithPreferencesPath,
} from "./appOpenWithPreferences";
import { AppRendererIpcBridge } from "./appRendererIpcBridge";
import { AppRendererRpcHost } from "./appRendererRpc";
import { AppRuntimeLifecycle } from "./appRuntimeLifecycle";
import { AppSessionManager } from "./appSessionManager";
import { AppRuntimeDiagnostics, resolveAppRuntimeDiagnosticsPath } from "./appRuntimeDiagnostics";
import { AppIdentityService } from "./appIdentityService";
import { AppDataVault } from "./appDataVault";
import { ProviderCredentialVault } from "./providerCredentialVault";
import { DeferredAppTabHost } from "./deferredAppTabHost";
import { ElectronAppControllerRendererFactory } from "./electronAppControllerRenderer";
import { ElectronAppTabHost, type AppUpdateTabSnapshot } from "./electronAppTabHost";
import {
  AppUpdateJournal,
  resolveAppUpdateJournalPath,
  type AppUpdateRecovery,
} from "./appUpdateJournal";

export interface DesktopAppRuntime {
  readonly store: AppInstallationStore;
  readonly installations: AppInstallationService;
  readonly packages: AppPackageIngestor;
  readonly broker: AppOperationBroker;
  readonly operationCatalog: AppOperationCatalog;
  readonly intents: AppIntentRouter;
  readonly openWith: AppOpenWithPreferenceStore;
  readonly tabs: DeferredAppTabHost;
  readonly appTabs: ElectronAppTabHost;
  readonly diagnostics: AppRuntimeDiagnostics;
  readonly identities: AppIdentityService;
  readonly vault: AppDataVault;
  readonly providerCredentialVault: ProviderCredentialVault;
  readonly safeStartRecovery: null | { quarantinedPath: string; error: Error };
  readonly updateRecovery: AppUpdateRecovery | null;
  readonly packageGarbageCollection: AppPackageGarbageCollectionResult;
  canManageInstallations(rendererId: number): boolean;
  installationSpaceId(rendererId: number): string | null;
  rendererIdentity(
    rendererId: number,
  ): { appId: string; spaceId: string; threadId?: string; tabId?: string } | null;
  stop(): Promise<void>;
}

export async function startDesktopAppRuntime(input: {
  userDataPath: string;
  appPreloadPath: string;
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
  window: () => BrowserWindow | null;
  onTabOpened: (descriptor: DesktopAppTabDescriptor) => void;
  onTabState: (descriptor: DesktopAppTabDescriptor) => void;
  onTabClosed: (descriptor: DesktopAppTabClosed) => void;
  onTabRendererCreated?: (renderer: WebContents) => (() => void) | void;
  onInvalidRendererMessage?: (error: Error, senderId: number) => void;
  assertAppAllowed?: (app: import("./appInstallationState").InstalledAppPackage) => Promise<void>;
  getAccountId?: () => Promise<string | null>;
  requestStandardPermissions?: (input: {
    appId: string;
    appName: string;
    spaceId: string;
    permissions: ReadonlyArray<import("./appStandardPermissions").AppStandardPermissionName>;
  }) => Promise<boolean>;
}): Promise<DesktopAppRuntime> {
  const storeResult = await AppInstallationStore.openSafe(
    resolveAppInstallationStatePath(input.userDataPath),
  );
  const store = storeResult.store;
  const updates = new AppUpdateJournal(resolveAppUpdateJournalPath(input.userDataPath));
  const updateRecovery = await updates.recoverSafe(store);
  const packages = new AppPackageIngestor(resolveAppPackageStorePath(input.userDataPath));
  const diagnostics = new AppRuntimeDiagnostics(
    resolveAppRuntimeDiagnosticsPath(input.userDataPath),
  );
  const identities = await AppIdentityService.open({
    userDataPath: input.userDataPath,
    getAccountId: input.getAccountId ?? (async () => null),
  });
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Secure App secret storage is unavailable on this device.");
  const vault = await AppDataVault.open({
    userDataPath: input.userDataPath,
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  const providerCredentialVault = await ProviderCredentialVault.open({
    userDataPath: input.userDataPath,
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  const recordDiagnostic = (entry: import("./appRuntimeDiagnostics").AppRuntimeDiagnosticInput) => {
    void diagnostics.record(entry).catch((error) => {
      console.error("[penkra-app] Could not persist App runtime diagnostics.", error);
    });
  };
  const packageGarbageCollection = await packages.collectGarbage(
    Object.values(store.snapshot().packagesByInstallationKey).map(
      (installed) => installed.packagePath,
    ),
  );
  const tabs = new DeferredAppTabHost();
  const rpc = new AppRendererRpcHost();
  const ipcBridge = new AppRendererIpcBridge({
    ipcMain: input.ipcMain,
    rpc,
    ...(input.onInvalidRendererMessage === undefined
      ? {}
      : { onInvalidMessage: input.onInvalidRendererMessage }),
  });
  ipcBridge.start();
  let ensureAppRuntimeActive: (appId: string, spaceId: string) => Promise<void> = async () => {
    throw new Error("The App runtime lifecycle is not ready.");
  };
  const broker = new AppOperationBroker({
    installationState: () => store.snapshot(),
    tabs,
    resolveIdentity: (appId, spaceId) => identities.resolve(appId, spaceId),
    ensureController: (appId, spaceId) => ensureAppRuntimeActive(appId, spaceId),
    onDiagnostic: recordDiagnostic,
  });
  const operationCatalog = new AppOperationCatalog(() => store.snapshot());
  const intents = new AppIntentRouter(() => store.snapshot());
  const openWith = await AppOpenWithPreferenceStore.open(
    resolveAppOpenWithPreferencesPath(input.userDataPath),
  );
  let installations!: AppInstallationService;
  const sessions = new AppSessionManager({
    getStandardPermission: (appId, spaceId, permission) => {
      const space = Object.values(store.snapshot().spaceStateByKey).find(
        (candidate) => candidate.appId === appId && candidate.spaceId === spaceId,
      );
      return space?.permissions[permission] === "granted";
    },
    requestStandardPermissions: async (request) => {
      const granted = await (input.requestStandardPermissions?.(request) ?? Promise.resolve(false));
      for (const permission of request.permissions) {
        await installations.setRuntimePermission({
          appId: request.appId,
          spaceId: request.spaceId,
          permission,
          grant: granted ? "granted" : "denied",
        });
      }
      return granted;
    },
  });
  const rendererIdentities = new Map<
    number,
    { appId: string; spaceId: string; threadId?: string; tabId?: string }
  >();
  const registerRendererIdentity = ({
    appId,
    spaceId,
    threadId,
    tabId,
    rendererId,
  }: {
    appId: string;
    spaceId: string;
    threadId?: string;
    tabId?: string;
    rendererId: number;
  }) => {
    const identity = {
      appId,
      spaceId,
      ...(threadId === undefined ? {} : { threadId }),
      ...(tabId === undefined ? {} : { tabId }),
    };
    rendererIdentities.set(rendererId, identity);
    const renderer = tabId === undefined ? null : webContents.fromId(rendererId);
    const releaseTabRenderer = renderer ? input.onTabRendererCreated?.(renderer) : undefined;
    return () => {
      releaseTabRenderer?.();
      if (rendererIdentities.get(rendererId) === identity) rendererIdentities.delete(rendererId);
    };
  };
  const controllerHost = new AppControllerHost({
    broker,
    rpc,
    renderers: new ElectronAppControllerRendererFactory({
      preloadPath: input.appPreloadPath,
      ipcBridge,
      onRendererCreated: registerRendererIdentity,
    }),
  });
  let appTabs!: ElectronAppTabHost;
  const lifecycle = new AppRuntimeLifecycle({
    store,
    sessions,
    controllers: controllerHost,
    ...(input.assertAppAllowed === undefined ? {} : { assertAppAllowed: input.assertAppAllowed }),
    closeTabs: (appId, spaceId, reason) => appTabs.closeForAppSpace(appId, spaceId, reason),
  });
  ensureAppRuntimeActive = (appId, spaceId) => lifecycle.ensureActive(appId, spaceId);
  installations = new AppInstallationService({
    store,
    lifecycle,
    data: {
      eraseData: async (appId, spaceId, eraseAppHandles) => {
        await sessions.eraseData(appId, spaceId);
        await vault.erase(appId, eraseAppHandles ? undefined : spaceId);
      },
    },
    settingSecrets: vault,
    updates,
    tabs: {
      capture: (appId, spaceId) => appTabs.captureForUpdate(appId, spaceId),
      restore: (appId, spaceId, snapshots) =>
        appTabs.restoreAfterUpdate(
          appId,
          spaceId,
          snapshots as ReadonlyArray<AppUpdateTabSnapshot>,
        ),
    },
  });
  appTabs = new ElectronAppTabHost({
    window: input.window,
    installations,
    sessions,
    broker,
    rpc,
    ipcBridge,
    preloadPath: input.appPreloadPath,
    onOpened: input.onTabOpened,
    onState: input.onTabState,
    onClosed: input.onTabClosed,
    onDiagnostic: recordDiagnostic,
    measureRendererMemory: (rendererId) => {
      const renderer = webContents.fromId(rendererId);
      if (!renderer || renderer.isDestroyed()) return undefined;
      const processId = renderer.getOSProcessId();
      const metric = app.getAppMetrics().find((candidate) => candidate.pid === processId);
      return metric ? metric.memory.workingSetSize * 1024 : undefined;
    },
    onRendererCreated: registerRendererIdentity,
    ...(input.assertAppAllowed === undefined ? {} : { assertAppAllowed: input.assertAppAllowed }),
  });
  const unbindTabs = tabs.bind(appTabs);
  const unsubscribeUnexpectedDisable = lifecycle.subscribeUnexpectedDisable((event) => {
    recordDiagnostic({
      kind: "runtime-disabled",
      appId: event.appId,
      spaceId: event.spaceId,
      message: event.error.message,
    });
  });
  let stopped = false;

  return {
    store,
    installations,
    packages,
    broker,
    operationCatalog,
    intents,
    openWith,
    tabs,
    appTabs,
    diagnostics,
    identities,
    vault,
    providerCredentialVault,
    safeStartRecovery: storeResult.recovery,
    updateRecovery,
    packageGarbageCollection,
    canManageInstallations: (rendererId) =>
      rendererIdentities.get(rendererId)?.appId === "com.penkra.apps",
    installationSpaceId: (rendererId) => {
      const identity = rendererIdentities.get(rendererId);
      return identity?.appId === "com.penkra.apps" ? identity.spaceId : null;
    },
    rendererIdentity: (rendererId) => rendererIdentities.get(rendererId) ?? null,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        unsubscribeUnexpectedDisable();
        unbindTabs();
        appTabs.closeAll("host-stopped");
        await lifecycle.shutdown();
      } finally {
        ipcBridge.dispose();
        rpc.stop();
      }
    },
  };
}

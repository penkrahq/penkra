// FILE: desktopAppRuntime.ts
// Purpose: Composes trusted App persistence, isolation, controller, broker, and IPC services.
// Layer: Desktop main-process bootstrap

import { safeStorage, session, type IpcMain } from "electron";
import type {
  DesktopAppFrameHostMessage,
  DesktopAppTabClosed,
  DesktopAppTabDescriptor,
} from "@penkra/contracts";

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
import { AppFrameDocumentRegistry } from "./appFrameDocumentRegistry";
import { AppDataVault } from "./appDataVault";
import { ProviderCredentialVault } from "./providerCredentialVault";
import { DeferredAppTabHost } from "./deferredAppTabHost";
import { ElectronAppControllerProcessFactory } from "./electronAppControllerProcess";
import {
  ElectronAppTabHost,
  type AppTabAuthority,
  type AppUpdateTabSnapshot,
} from "./electronAppTabHost";
import {
  AppUpdateJournal,
  resolveAppUpdateJournalPath,
  type AppUpdateRecovery,
} from "./appUpdateJournal";
import { AppBlobUrlRegistry } from "./appBlobUrlRegistry";
import { AppTransferService } from "./appTransfer";
import { queryAppPermission } from "./appPermissionQuery";
import { AppRendererIdentityStore } from "./appRendererIdentityStore";
import { appRuntimeFailureDto, appRuntimeGroupFailure } from "./appRuntimeFailure";

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
  readonly blobUrls: AppBlobUrlRegistry;
  readonly transfers: AppTransferService;
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

function requireControllerRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export async function startDesktopAppRuntime(input: {
  userDataPath: string;
  appPreloadPath: string;
  appControllerRunnerPath: string;
  appFrameRuntimePath: string;
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
  onTabOpened: (descriptor: DesktopAppTabDescriptor) => void;
  onTabState: (descriptor: DesktopAppTabDescriptor) => void;
  onFrameHostMessage?: (input: DesktopAppFrameHostMessage) => void;
  onTabClosed: (descriptor: DesktopAppTabClosed) => void;
  tabAuthority?: AppTabAuthority;
  onInvalidRendererMessage?: (error: Error, senderId: number) => void;
  assertAppAllowed?: (app: import("./appInstallationState").InstalledAppPackage) => Promise<void>;
  getAccountId?: () => Promise<string | null>;
  eraseAppStorage?: (appId: string, spaceId: string) => Promise<void>;
  requestStandardPermissions?: (input: {
    appId: string;
    appName: string;
    spaceId: string;
    permissions: ReadonlyArray<import("./appStandardPermissions").AppStandardPermissionName>;
  }) => Promise<boolean>;
  controllerServiceCall?: (input: {
    appId: string;
    spaceId: string;
    method: string;
    input: unknown;
  }) => Promise<unknown>;
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
  const blobUrls = new AppBlobUrlRegistry();
  let appTabs!: ElectronAppTabHost;
  const transfers = new AppTransferService({
    emitProgress: (owner, event) => {
      try {
        appTabs.sendFrameEvent(owner.tabId, "transfer.progress", event);
      } catch {
        // Closing tabs revoke outstanding transfer authority.
      }
    },
  });
  const frameDocuments = new AppFrameDocumentRegistry({
    protocol: session.defaultSession.protocol,
    runtimeScriptPath: input.appFrameRuntimePath,
    resolveOrigin: (appId, spaceId) => identities.resolveOrigin(appId, spaceId),
    protocolResources: ({ origin }) => ({
      blobUrls,
      transferHandler: (request) => transfers.handleEndpoint(origin, request),
    }),
  });
  await frameDocuments.start();
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
    resolveOrigin: (appId, spaceId) => identities.resolveOrigin(appId, spaceId),
    protocolResources: ({ origin }) => ({
      blobUrls,
      transferHandler: (request) => transfers.handleEndpoint(origin, request),
    }),
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
  const rendererIdentities = new AppRendererIdentityStore();
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
    return rendererIdentities.register(rendererId, identity);
  };
  const controllerHost = new AppControllerHost({
    broker,
    rpc,
    processes: new ElectronAppControllerProcessFactory({
      runnerPath: input.appControllerRunnerPath,
      rpc,
      serviceCall: async (request) => {
        const identity = { appId: request.appId, spaceId: request.spaceId };
        switch (request.method) {
          case "identity.get":
            return identities.resolve(identity.appId, identity.spaceId);
          case "permissions.query":
            return queryAppPermission(store.snapshot(), identity, request.input);
          case "settings.get":
            if (typeof request.input !== "string") throw new Error("Setting key must be a string.");
            return installations.getSetting({ ...identity, key: request.input });
          case "settings.set": {
            const value = requireControllerRecord(request.input, "Setting input");
            if (typeof value.key !== "string") throw new Error("Setting key must be a string.");
            await installations.setSetting({ ...identity, key: value.key, value: value.value });
            return null;
          }
          case "settings.reset":
            if (typeof request.input !== "string") throw new Error("Setting key must be a string.");
            await installations.resetSetting({ ...identity, key: request.input });
            return null;
          case "secrets.get":
            if (typeof request.input !== "string") throw new Error("Secret name must be a string.");
            return vault.getSecret(identity.appId, identity.spaceId, request.input);
          case "secrets.set": {
            const value = requireControllerRecord(request.input, "Secret input");
            if (typeof value.name !== "string" || typeof value.value !== "string") {
              throw new Error("Secret name and value must be strings.");
            }
            await vault.setSecret(identity.appId, identity.spaceId, value.name, value.value);
            return null;
          }
          case "secrets.delete":
            if (typeof request.input !== "string") throw new Error("Secret name must be a string.");
            await vault.deleteSecret(identity.appId, identity.spaceId, request.input);
            return null;
          default:
            if (input.controllerServiceCall) return input.controllerServiceCall(request);
            throw Object.assign(
              new Error(`App controller service ${request.method} is unavailable.`),
              { code: "METHOD_NOT_SUPPORTED" },
            );
        }
      },
    }),
  });
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
        await input.eraseAppStorage?.(appId, spaceId);
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
    installations,
    sessions,
    frameDocuments,
    broker,
    rpc,
    ipcBridge,
    onOpened: input.onTabOpened,
    onState: input.onTabState,
    ...(input.onFrameHostMessage === undefined
      ? {}
      : { onFrameHostMessage: input.onFrameHostMessage }),
    onClosed: input.onTabClosed,
    onDiagnostic: recordDiagnostic,
    registerRendererIdentity,
    authority: {
      retireGeneration: (owner) => {
        const failures: Array<{ role: string; failure: unknown }> = [];
        let blobs: ReturnType<AppBlobUrlRegistry["detachGeneration"]> | null = null;
        let activeTransfers: ReturnType<AppTransferService["detachGeneration"]> | null = null;
        try {
          blobs = blobUrls.detachGeneration(owner);
        } catch (error) {
          failures.push({ role: "blob-urls-detach", failure: error });
        }
        try {
          activeTransfers = transfers.detachGeneration(owner);
        } catch (error) {
          failures.push({ role: "transfers-detach", failure: error });
        }
        try {
          rendererIdentities.detachGeneration(owner);
        } catch (error) {
          failures.push({ role: "renderer-identity-detach", failure: error });
        }
        try {
          input.tabAuthority?.retireGeneration(owner);
        } catch (error) {
          failures.push({ role: "desktop-authority-retire-generation", failure: error });
        }
        try {
          if (blobs) blobUrls.disposeDetached(blobs);
        } catch (error) {
          failures.push({ role: "blob-urls-dispose", failure: error });
        }
        try {
          if (activeTransfers) transfers.disposeDetached(activeTransfers);
        } catch (error) {
          failures.push({ role: "transfers-dispose", failure: error });
        }
        if (failures.length > 0) {
          const failure = appRuntimeGroupFailure(
            "App renderer-generation retirement was incomplete.",
            failures,
          );
          recordDiagnostic({
            kind: "operation-failed",
            appId: owner.appId,
            spaceId: owner.spaceId,
            tabId: owner.tabId,
            operation: "generation-retirement",
            message: failure.message,
            failure: appRuntimeFailureDto(failure),
          });
        }
      },
      retireTab: (owner) => {
        const failures: Array<{ role: string; failure: unknown }> = [];
        let blobs: ReturnType<AppBlobUrlRegistry["detachTab"]> | null = null;
        let activeTransfers: ReturnType<AppTransferService["detachTab"]> | null = null;
        try {
          blobs = blobUrls.detachTab(owner);
        } catch (error) {
          failures.push({ role: "blob-urls-detach", failure: error });
        }
        try {
          activeTransfers = transfers.detachTab(owner);
        } catch (error) {
          failures.push({ role: "transfers-detach", failure: error });
        }
        try {
          input.tabAuthority?.retireTab(owner);
        } catch (error) {
          failures.push({ role: "desktop-authority-retire-tab", failure: error });
        }
        try {
          if (blobs) blobUrls.disposeDetached(blobs);
        } catch (error) {
          failures.push({ role: "blob-urls-dispose", failure: error });
        }
        try {
          if (activeTransfers) transfers.disposeDetached(activeTransfers);
        } catch (error) {
          failures.push({ role: "transfers-dispose", failure: error });
        }
        if (failures.length > 0) {
          const failure = appRuntimeGroupFailure(
            "App logical-tab retirement was incomplete.",
            failures,
          );
          recordDiagnostic({
            kind: "operation-failed",
            appId: owner.appId,
            spaceId: owner.spaceId,
            tabId: owner.tabId,
            operation: "tab-retirement",
            message: failure.message,
            failure: appRuntimeFailureDto(failure),
          });
        }
      },
    },
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
    blobUrls,
    transfers,
    safeStartRecovery: storeResult.recovery,
    updateRecovery,
    packageGarbageCollection,
    canManageInstallations: (rendererId) =>
      rendererIdentities.get(rendererId)?.appId === "com.penkra.apps",
    installationSpaceId: (rendererId) => {
      const identity = rendererIdentities.get(rendererId);
      return identity?.appId === "com.penkra.apps" ? identity.spaceId : null;
    },
    rendererIdentity: (rendererId) => rendererIdentities.get(rendererId),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        unsubscribeUnexpectedDisable();
        unbindTabs();
        appTabs.closeAll("host-stopped");
        blobUrls.clear();
        transfers.clear();
        await lifecycle.shutdown();
        await frameDocuments.dispose();
      } finally {
        ipcBridge.dispose();
        rpc.stop();
      }
    },
  };
}

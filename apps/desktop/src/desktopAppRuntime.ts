// FILE: desktopAppRuntime.ts
// Purpose: Composes trusted App persistence, isolation, controller, broker, and IPC services.
// Layer: Desktop main-process bootstrap

import type { BrowserWindow, IpcMain } from "electron";
import type { DesktopAppTabDescriptor } from "@penkra/contracts";

import { AppControllerHost } from "./appControllerHost";
import {
  AppInstallationStore,
  resolveAppInstallationStatePath,
} from "./appInstallationStore";
import { AppInstallationService } from "./appInstallationService";
import { AppPackageIngestor, resolveAppPackageStorePath } from "./appPackageIngestor";
import { AppOperationBroker } from "./appOperationBroker";
import { AppRendererIpcBridge } from "./appRendererIpcBridge";
import { AppRendererRpcHost } from "./appRendererRpc";
import { AppRuntimeLifecycle, type AppRuntimeRestoreResult } from "./appRuntimeLifecycle";
import { AppSessionManager } from "./appSessionManager";
import { DeferredAppTabHost } from "./deferredAppTabHost";
import { ElectronAppControllerRendererFactory } from "./electronAppControllerRenderer";
import { ElectronAppTabHost } from "./electronAppTabHost";
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
  readonly tabs: DeferredAppTabHost;
  readonly appTabs: ElectronAppTabHost;
  readonly restoreResults: ReadonlyArray<AppRuntimeRestoreResult>;
  readonly safeStartRecovery: null | { quarantinedPath: string; error: Error };
  readonly updateRecovery: AppUpdateRecovery | null;
  canManageInstallations(rendererId: number): boolean;
  installationSpaceId(rendererId: number): string | null;
  stop(): Promise<void>;
}

export async function startDesktopAppRuntime(input: {
  userDataPath: string;
  appPreloadPath: string;
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
  window: () => BrowserWindow | null;
  onTabOpened: (descriptor: DesktopAppTabDescriptor) => void;
  onTabState: (descriptor: DesktopAppTabDescriptor) => void;
  onInvalidRendererMessage?: (error: Error, senderId: number) => void;
  assertAppAllowed?: (app: import("./appInstallationState").InstalledAppPackage) => Promise<void>;
}): Promise<DesktopAppRuntime> {
  const storeResult = await AppInstallationStore.openSafe(
    resolveAppInstallationStatePath(input.userDataPath),
  );
  const store = storeResult.store;
  const updates = new AppUpdateJournal(resolveAppUpdateJournalPath(input.userDataPath));
  const updateRecovery = await updates.recoverSafe(store);
  const tabs = new DeferredAppTabHost();
  const rpc = new AppRendererRpcHost();
  const ipcBridge = new AppRendererIpcBridge({
    ipcMain: input.ipcMain,
    rpc,
    onInvalidMessage: input.onInvalidRendererMessage,
  });
  ipcBridge.start();
  const broker = new AppOperationBroker({
    installationState: () => store.snapshot(),
    tabs,
  });
  const sessions = new AppSessionManager();
  const trustedInstallationRenderers = new Map<number, string>();
  const registerRendererIdentity = ({
    appId,
    spaceId,
    rendererId,
  }: {
    appId: string;
    spaceId: string;
    rendererId: number;
  }) => {
    if (appId !== "com.penkra.apps") return;
    trustedInstallationRenderers.set(rendererId, spaceId);
    return () => trustedInstallationRenderers.delete(rendererId);
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
  const installations = new AppInstallationService({ store, lifecycle, updates });
  const packages = new AppPackageIngestor(resolveAppPackageStorePath(input.userDataPath));
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
    onRendererCreated: registerRendererIdentity,
    ...(input.assertAppAllowed === undefined ? {} : { assertAppAllowed: input.assertAppAllowed }),
  });
  const unbindTabs = tabs.bind(appTabs);
  const restoreResults = await lifecycle.restoreEnabled();
  let stopped = false;

  return {
    store,
    installations,
    packages,
    broker,
    tabs,
    appTabs,
    restoreResults,
    safeStartRecovery: storeResult.recovery,
    updateRecovery,
    canManageInstallations: (rendererId) => trustedInstallationRenderers.has(rendererId),
    installationSpaceId: (rendererId) => trustedInstallationRenderers.get(rendererId) ?? null,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
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

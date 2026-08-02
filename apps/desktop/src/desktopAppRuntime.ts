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

export interface DesktopAppRuntime {
  readonly store: AppInstallationStore;
  readonly installations: AppInstallationService;
  readonly packages: AppPackageIngestor;
  readonly broker: AppOperationBroker;
  readonly tabs: DeferredAppTabHost;
  readonly appTabs: ElectronAppTabHost;
  readonly restoreResults: ReadonlyArray<AppRuntimeRestoreResult>;
  canManageInstallations(rendererId: number): boolean;
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
}): Promise<DesktopAppRuntime> {
  const store = await AppInstallationStore.open(
    resolveAppInstallationStatePath(input.userDataPath),
  );
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
  const trustedInstallationRendererIds = new Set<number>();
  const registerRendererIdentity = ({ appId, rendererId }: { appId: string; rendererId: number }) => {
    if (appId !== "com.penkra.apps") return;
    trustedInstallationRendererIds.add(rendererId);
    return () => trustedInstallationRendererIds.delete(rendererId);
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
  const lifecycle = new AppRuntimeLifecycle({
    store,
    sessions,
    controllers: controllerHost,
  });
  const installations = new AppInstallationService({ store, lifecycle });
  const packages = new AppPackageIngestor(resolveAppPackageStorePath(input.userDataPath));
  const appTabs = new ElectronAppTabHost({
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
    canManageInstallations: (rendererId) => trustedInstallationRendererIds.has(rendererId),
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

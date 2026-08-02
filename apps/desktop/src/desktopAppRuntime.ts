// FILE: desktopAppRuntime.ts
// Purpose: Composes trusted App persistence, isolation, controller, broker, and IPC services.
// Layer: Desktop main-process bootstrap

import type { IpcMain } from "electron";

import { AppControllerHost } from "./appControllerHost";
import {
  AppInstallationStore,
  resolveAppInstallationStatePath,
} from "./appInstallationStore";
import { AppOperationBroker } from "./appOperationBroker";
import { AppRendererIpcBridge } from "./appRendererIpcBridge";
import { AppRendererRpcHost } from "./appRendererRpc";
import { AppRuntimeLifecycle, type AppRuntimeRestoreResult } from "./appRuntimeLifecycle";
import { AppSessionManager } from "./appSessionManager";
import { DeferredAppTabHost } from "./deferredAppTabHost";
import { ElectronAppControllerRendererFactory } from "./electronAppControllerRenderer";

export interface DesktopAppRuntime {
  readonly store: AppInstallationStore;
  readonly broker: AppOperationBroker;
  readonly tabs: DeferredAppTabHost;
  readonly restoreResults: ReadonlyArray<AppRuntimeRestoreResult>;
  stop(): Promise<void>;
}

export async function startDesktopAppRuntime(input: {
  userDataPath: string;
  appPreloadPath: string;
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
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
  const controllerHost = new AppControllerHost({
    broker,
    rpc,
    renderers: new ElectronAppControllerRendererFactory({
      preloadPath: input.appPreloadPath,
      ipcBridge,
    }),
  });
  const lifecycle = new AppRuntimeLifecycle({
    store,
    sessions,
    controllers: controllerHost,
  });
  const restoreResults = await lifecycle.restoreEnabled();
  let stopped = false;

  return {
    store,
    broker,
    tabs,
    restoreResults,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await lifecycle.shutdown();
      } finally {
        ipcBridge.dispose();
        rpc.stop();
      }
    },
  };
}

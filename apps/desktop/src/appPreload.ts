// FILE: appPreload.ts
// Purpose: Exposes the narrow framework-neutral Penkra App API to isolated App documents.
// Layer: Untrusted App renderer preload

import { contextBridge, ipcRenderer } from "electron";

import { AppPreloadRuntime } from "./appPreloadRuntime";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { PENKRA_APP_ID_ARGUMENT_PREFIX } from "./appRuntimePolicy";

const runtime = new AppPreloadRuntime({
  send: (message) => ipcRenderer.send(APP_RUNTIME_IPC_CHANNELS.rendererMessage, message),
  onHostMessage: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message);
    ipcRenderer.on(APP_RUNTIME_IPC_CHANNELS.hostMessage, wrapped);
    return () => ipcRenderer.removeListener(APP_RUNTIME_IPC_CHANNELS.hostMessage, wrapped);
  },
  ready: () => ipcRenderer.send(APP_RUNTIME_IPC_CHANNELS.ready),
  queryPermission: (name) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.permissionQuery, name),
});

const appId = process.argv
  .find((argument) => argument.startsWith(PENKRA_APP_ID_ARGUMENT_PREFIX))
  ?.slice(PENKRA_APP_ID_ARGUMENT_PREFIX.length);
const exposedApi =
  appId === "com.penkra.apps"
    ? {
        ...runtime.api,
        installations: {
          getState: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.getState),
          installRegistry: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.installRegistry, input),
          updateRegistry: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.updateRegistry, input),
          rollbackRegistry: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.rollbackRegistry, input),
          setEnabled: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.setEnabled, input),
          setPermission: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.setPermission, input),
          uninstall: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.uninstall, input),
          removeData: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.removeData, input),
        },
        registry: {
          list: (input?: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.list, input),
          get: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.get, input),
          getArtifact: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.getArtifact, input),
        },
      }
    : runtime.api;

contextBridge.exposeInMainWorld("penkra", exposedApi);
runtime.start();
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => runtime.markReady(), { once: true });
} else {
  runtime.markReady();
}

// FILE: appPreload.ts
// Purpose: Exposes the narrow framework-neutral Penkra App API to isolated App documents.
// Layer: Untrusted App renderer preload

import { contextBridge, ipcRenderer } from "electron";

import { AppPreloadRuntime } from "./appPreloadRuntime";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";

const runtime = new AppPreloadRuntime({
  send: (message) => ipcRenderer.send(APP_RUNTIME_IPC_CHANNELS.rendererMessage, message),
  onHostMessage: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message);
    ipcRenderer.on(APP_RUNTIME_IPC_CHANNELS.hostMessage, wrapped);
    return () => ipcRenderer.removeListener(APP_RUNTIME_IPC_CHANNELS.hostMessage, wrapped);
  },
  ready: () => ipcRenderer.send(APP_RUNTIME_IPC_CHANNELS.ready),
});

contextBridge.exposeInMainWorld("penkra", runtime.api);
runtime.start();
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => runtime.markReady(), { once: true });
} else {
  runtime.markReady();
}

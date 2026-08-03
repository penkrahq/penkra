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
  requestPermission: (name) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.permissionRequest, name),
  getIdentity: () => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.identityGet),
  settingGet: (key) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.settingGet, key),
  settingSet: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.settingSet, input),
  settingReset: (key) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.settingReset, key),
  secretGet: (name) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.secretGet, name),
  secretSet: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.secretSet, input),
  secretDelete: (name) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.secretDelete, name),
  filePick: (kind) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.filePick, kind),
  fileList: () => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileList),
  fileReadText: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileReadText, input),
  fileWriteText: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileWriteText, input),
  fileStat: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileStat, input),
  fileListDirectory: (input) =>
    ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileListDirectory, input),
  fileReadBinary: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileReadBinary, input),
  fileWriteBinary: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileWriteBinary, input),
  fileCreateDirectory: (input) =>
    ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileCreateDirectory, input),
  fileRename: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileRename, input),
  fileRemove: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileRemove, input),
  fileWatch: async (input, listener) => {
    const watchId = (await ipcRenderer.invoke(
      APP_RUNTIME_IPC_CHANNELS.fileWatchStart,
      input,
    )) as string;
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      message: { watchId?: string; event?: import("@penkra/sdk").AppFileChangeEvent },
    ) => {
      if (message?.watchId === watchId && message.event) listener(message.event);
    };
    ipcRenderer.on(APP_RUNTIME_IPC_CHANNELS.fileChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(APP_RUNTIME_IPC_CHANNELS.fileChanged, wrapped);
      void ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileWatchStop, { watchId });
    };
  },
  fileOpenChild: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileOpenChild, input),
  fileRevoke: (handleId) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.fileRevoke, handleId),
  resourceOpen: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.resourceOpen, input),
  browserCall: (method, input) =>
    ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.browserCall, { method, input }),
  onBrowserState: (listener) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      state: import("@penkra/sdk").AppBrowserSessionState,
    ) => listener(state);
    ipcRenderer.on(APP_RUNTIME_IPC_CHANNELS.browserState, wrapped);
    return () => ipcRenderer.removeListener(APP_RUNTIME_IPC_CHANNELS.browserState, wrapped);
  },
  networkFetch: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.networkFetch, input),
  rawSocketExchange: (input) =>
    ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.rawSocketExchange, input),
  processRun: (input) => ipcRenderer.invoke(APP_RUNTIME_IPC_CHANNELS.processRun, input),
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
          getSettings: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.getSettings, input),
          setSetting: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.setSetting, input),
          resetSetting: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.resetSetting, input),
          setSkillEnabled: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.setSkillEnabled, input),
          uninstall: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.uninstall, input),
          removeData: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appInstallations.removeData, input),
        },
        registry: {
          list: (input?: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.list, input),
          get: (input: unknown) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.get, input),
          getArtifact: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.getArtifact, input),
          getFeedback: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.getFeedback, input),
          setRating: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.setRating, input),
          setReview: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appRegistry.setReview, input),
        },
        apps: {
          open: (input: unknown) =>
            ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.appTabs.openFromApps, input),
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

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge } from "@penkra/contracts";
import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const IPC = DESKTOP_IPC_CHANNELS;

function getDesktopWsUrl(): string | null {
  try {
    const ipcWsUrl = normalizeDesktopWsUrl(ipcRenderer.sendSync(IPC.wsUrl));
    return ipcWsUrl ?? resolveDesktopWsUrlFromEnv(process.env);
  } catch {
    return resolveDesktopWsUrlFromEnv(process.env);
  }
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: getDesktopWsUrl,
  // Absolute path for OS-dropped File objects (folders with spaces/parens, etc.).
  getPathForFile: (file: File) => {
    try {
      const path = webUtils.getPathForFile(file);
      return typeof path === "string" && path.trim().length > 0 ? path : null;
    } catch {
      return null;
    }
  },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  saveFile: (input) => ipcRenderer.invoke(IPC.saveFile, input),
  confirm: (input) => ipcRenderer.invoke(IPC.confirm, input),
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  setSpacesMenu: (input) => ipcRenderer.invoke(IPC.setSpacesMenu, input),
  showContextMenu: (items, position) => ipcRenderer.invoke(IPC.contextMenu, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  shell: {
    showInFolder: (path: string) => ipcRenderer.invoke(IPC.showInFolder, path),
  },
  clipboard: {
    writeImagePngDataUrl: (dataUrl: string) => ipcRenderer.invoke(IPC.clipboardWriteImage, dataUrl),
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    getState: () => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(IPC.windowState, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.windowState, wrappedListener);
      };
    },
  },
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IPC.menuAction, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.menuAction, wrappedListener);
    };
  },
  getZoomFactor: () => {
    const factor = ipcRenderer.sendSync(IPC.zoomFactor);
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  },
  onZoomFactorChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, factor: unknown) => {
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return;
      listener(factor);
    };

    ipcRenderer.on(IPC.zoomFactorChanged, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.zoomFactorChanged, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGetState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IPC.updateState, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC.updateState, wrappedListener);
    };
  },
  notifications: {
    isSupported: () => ipcRenderer.invoke(IPC.notificationsIsSupported),
    show: (input) => ipcRenderer.invoke(IPC.notificationsShow, input),
  },
  media: {
    requestMicrophoneAccess: () => ipcRenderer.invoke(IPC.mediaRequestMicrophoneAccess),
    setVoiceRecordingActive: (recordingId, active) =>
      ipcRenderer.invoke(IPC.mediaSetVoiceRecordingActive, recordingId, active),
  },
  accountAuth: {
    getState: () => ipcRenderer.invoke(IPC.accountAuth.getState),
    requestSignIn: () => ipcRenderer.invoke(IPC.accountAuth.requestSignIn),
    requestSignUp: () => ipcRenderer.invoke(IPC.accountAuth.requestSignUp),
    signOut: () => ipcRenderer.invoke(IPC.accountAuth.signOut),
    onCallbackStarted: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, callback: unknown) => {
        if (typeof callback !== "object" || callback === null) return;
        listener(callback as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.accountAuth.callbackStarted, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.accountAuth.callbackStarted, wrappedListener);
    },
    onAuthenticated: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, user: unknown) => {
        if (typeof user !== "object" || user === null) return;
        listener(user as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.accountAuth.authenticated, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.accountAuth.authenticated, wrappedListener);
    },
    onUserUpdated: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, user: unknown) => {
        if (user !== null && (typeof user !== "object" || user === null)) return;
        listener(user as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.accountAuth.userUpdated, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.accountAuth.userUpdated, wrappedListener);
    },
    onError: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, error: unknown) => {
        if (typeof error !== "object" || error === null) return;
        listener(error as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.accountAuth.error, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.accountAuth.error, wrappedListener);
    },
  },
  appInstallations: {
    getState: () => ipcRenderer.invoke(IPC.appInstallations.getState),
    installRegistry: (input) => ipcRenderer.invoke(IPC.appInstallations.installRegistry, input),
    setEnabled: (input) => ipcRenderer.invoke(IPC.appInstallations.setEnabled, input),
    setPermission: (input) => ipcRenderer.invoke(IPC.appInstallations.setPermission, input),
    uninstall: (input) => ipcRenderer.invoke(IPC.appInstallations.uninstall, input),
    removeData: (input) => ipcRenderer.invoke(IPC.appInstallations.removeData, input),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.appInstallations.state, wrappedListener);
      return () => ipcRenderer.removeListener(IPC.appInstallations.state, wrappedListener);
    },
  },
  appTabs: {
    list: () => ipcRenderer.invoke(IPC.appTabs.list),
    open: (input) => ipcRenderer.invoke(IPC.appTabs.open, input),
    attach: (input) => ipcRenderer.invoke(IPC.appTabs.attach, input),
    setBounds: (input) => ipcRenderer.invoke(IPC.appTabs.setBounds, input),
    setVisible: (input) => ipcRenderer.invoke(IPC.appTabs.setVisible, input),
    close: (input) => ipcRenderer.invoke(IPC.appTabs.close, input),
    onOpened: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, tab: Parameters<typeof listener>[0]) =>
        listener(tab);
      ipcRenderer.on(IPC.appTabs.opened, wrapped);
      return () => ipcRenderer.removeListener(IPC.appTabs.opened, wrapped);
    },
    onState: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, tab: Parameters<typeof listener>[0]) =>
        listener(tab);
      ipcRenderer.on(IPC.appTabs.state, wrapped);
      return () => ipcRenderer.removeListener(IPC.appTabs.state, wrapped);
    },
  },
  storageMigration: {
    readSnapshot: () => ipcRenderer.sendSync(IPC.storageMigration.read),
    acknowledgeSnapshot: () => ipcRenderer.invoke(IPC.storageMigration.acknowledge),
  },
  server: {
    transcribeVoice: (input) => ipcRenderer.invoke(IPC.transcribeVoice, input),
  },
  browser: {
    open: (input) => ipcRenderer.invoke(IPC.browser.open, input),
    close: (input) => ipcRenderer.invoke(IPC.browser.close, input),
    hide: (input) => ipcRenderer.invoke(IPC.browser.hide, input),
    getState: (input) => ipcRenderer.invoke(IPC.browser.getState, input),
    setPanelBounds: async (input) => {
      ipcRenderer.send(IPC.browser.setBounds, input);
    },
    attachWebview: (input) => ipcRenderer.invoke(IPC.browser.attachWebview, input),
    detachWebview: (input) => ipcRenderer.invoke(IPC.browser.detachWebview, input),
    copyLink: (input) => ipcRenderer.invoke(IPC.browser.requestCopyLink, input),
    copyScreenshotToClipboard: (input) =>
      ipcRenderer.invoke(IPC.browser.copyScreenshotToClipboard, input),
    captureScreenshot: (input) => ipcRenderer.invoke(IPC.browser.captureScreenshot, input),
    executeCdp: (input) => ipcRenderer.invoke(IPC.browser.executeCdp, input),
    findInPage: (input) => ipcRenderer.invoke(IPC.browser.findInPage, input),
    stopFindInPage: (input) => ipcRenderer.invoke(IPC.browser.stopFindInPage, input),
    navigate: (input) => ipcRenderer.invoke(IPC.browser.navigate, input),
    reload: (input) => ipcRenderer.invoke(IPC.browser.reload, input),
    goBack: (input) => ipcRenderer.invoke(IPC.browser.goBack, input),
    goForward: (input) => ipcRenderer.invoke(IPC.browser.goForward, input),
    newTab: (input) => ipcRenderer.invoke(IPC.browser.newTab, input),
    closeTab: (input) => ipcRenderer.invoke(IPC.browser.closeTab, input),
    selectTab: (input) => ipcRenderer.invoke(IPC.browser.selectTab, input),
    openDevTools: (input) => ipcRenderer.invoke(IPC.browser.openDevTools, input),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(IPC.browser.state, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.state, wrappedListener);
      };
    },
    onBrowserUseOpenPanelRequest: (listener) => {
      const wrappedListener = () => listener();
      ipcRenderer.on(IPC.browser.requestOpenPanel, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.requestOpenPanel, wrappedListener);
      };
    },
    onBrowserCopyLink: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        listener(payload as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IPC.browser.copyLink, wrappedListener);
      return () => {
        ipcRenderer.removeListener(IPC.browser.copyLink, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);

// FILE: simulatorViewerPreload.ts
// Purpose: Exposes frame delivery and normalized input for the trusted local Simulator viewer only.
// Layer: Trusted hosted-view preload

import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

contextBridge.exposeInMainWorld("penkraSimulatorViewer", {
  onFrame(listener: (frame: { dataUrl: string }) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const { dataUrl } = value as Record<string, unknown>;
      if (
        typeof dataUrl === "string" &&
        dataUrl.length <= 24 * 1024 * 1024 &&
        /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
      ) {
        listener({ dataUrl });
      }
    };
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.simulatorViewer.frame, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.simulatorViewer.frame, wrapped);
  },
  input(method: "tap" | "swipe" | "type", value: unknown): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.simulatorViewer.input, { method, value });
  },
});

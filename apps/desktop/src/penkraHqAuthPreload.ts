import { contextBridge, ipcRenderer } from "electron";

import { PENKRA_HQ_AUTH_CHANNEL, type PenkraHqAuthResult } from "./penkraHqAuth";

contextBridge.exposeInMainWorld("penkraHqAuth", {
  submit: (password: string): Promise<PenkraHqAuthResult> =>
    ipcRenderer.invoke(PENKRA_HQ_AUTH_CHANNEL, password),
});

const { contextBridge, ipcRenderer } = require("electron");
const listen = (channel, cb) => {
  const f = (_e, v) => cb(v);
  ipcRenderer.on(channel, f);
  return () => ipcRenderer.removeListener(channel, f);
};
contextBridge.exposeInMainWorld("desktopBridge", {
  qa: { seed: () => ipcRenderer.invoke("qa-seed"), ready: () => ipcRenderer.send("qa-ready") },
  appTabs: {
    present: (v) => ipcRenderer.invoke("qa-present", v),
    hide: (v) => ipcRenderer.invoke("qa-hide", v),
    trace: (v) => ipcRenderer.send("qa-trace", v),
    onPresentation: (cb) => listen("qa-presentation", cb),
  },
});

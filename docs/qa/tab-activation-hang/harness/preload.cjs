const { contextBridge, ipcRenderer } = require("electron");
const ch = (prefix) => "desktop:app-tabs-" + prefix;
const listen = (channel, callback) => {
  const handler = (_e, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld("desktopBridge", {
  appTabs: {
    claimActivation: (id) => ipcRenderer.invoke(ch("claim-activation"), id),
    failActivation: (id, message) => ipcRenderer.invoke(ch("fail-activation"), id, message),
    present: (input) => ipcRenderer.invoke(ch("present"), input),
    hide: (input) => ipcRenderer.invoke(ch("hide"), input),
    trace: (input) => ipcRenderer.send(ch("trace"), input),
    onActivationRequested: (cb) => listen(ch("activation-requested"), cb),
    onPresentation: (cb) => listen(ch("presentation"), cb),
    onOpened: (cb) => listen(ch("opened"), cb),
    onState: (cb) => listen(ch("state"), cb),
    onClosed: (cb) => listen(ch("closed"), cb),
    list: () => ipcRenderer.invoke("qa-list"),
    setContext: () => Promise.resolve(),
    consumeListingRequest: () => Promise.resolve(null),
    onListingRequested: (cb) => listen(ch("listing-requested"), cb),
  },
  getWindowState: () => Promise.resolve({ maximized: false, fullscreen: false }),
  onWindowStateChanged: () => () => {},
  setAppDockWidth: () => {},
  qa: { getSeed: () => ipcRenderer.invoke("qa-seed"), ready: () => ipcRenderer.send("qa-ready") },
});

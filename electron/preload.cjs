const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('penkraWindow', {
  setMode(mode) {
    ipcRenderer.send('penkra:set-window-mode', mode);
  },
});

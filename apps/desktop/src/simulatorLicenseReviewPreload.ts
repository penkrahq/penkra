// FILE: simulatorLicenseReviewPreload.ts
// Purpose: Sends explicit choices from the host-owned Android license review window.
// Layer: Trusted desktop preload

import { ipcRenderer } from "electron";

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

window.addEventListener("DOMContentLoaded", () => {
  const accept = document.getElementById("accept");
  const cancel = document.getElementById("cancel");
  accept?.addEventListener("click", () => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.simulatorLicenseReview.response, true);
  });
  cancel?.addEventListener("click", () => {
    ipcRenderer.send(DESKTOP_IPC_CHANNELS.simulatorLicenseReview.response, false);
  });
});

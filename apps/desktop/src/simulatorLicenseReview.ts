// FILE: simulatorLicenseReview.ts
// Purpose: Presents official Android SDK license text in host-owned trusted chrome.
// Layer: Trusted desktop UI

import { BrowserWindow, ipcMain, nativeTheme, type WebContents } from "electron";

import type { AndroidSdkLicensePrompt } from "./androidSdkLicenseReviewer";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

let reviewQueue: Promise<void> = Promise.resolve();

export function queueAndroidSdkLicenseReview(input: {
  parent: BrowserWindow | null;
  preloadPath: string;
  prompt: AndroidSdkLicensePrompt;
  signal: AbortSignal;
}): Promise<boolean> {
  const review = reviewQueue.then(() => showAndroidSdkLicenseReview(input));
  reviewQueue = review.then(
    () => undefined,
    () => undefined,
  );
  return review;
}

export async function showAndroidSdkLicenseReview(input: {
  parent: BrowserWindow | null;
  preloadPath: string;
  prompt: AndroidSdkLicensePrompt;
  signal: AbortSignal;
}): Promise<boolean> {
  if (input.signal.aborted) throw cancelledError();
  const window = new BrowserWindow({
    width: 760,
    height: 660,
    minWidth: 560,
    minHeight: 460,
    show: false,
    modal: Boolean(input.parent),
    ...(input.parent ? { parent: input.parent } : {}),
    autoHideMenuBar: true,
    title: "Review Android SDK license",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#171717" : "#ffffff",
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const sender = window.webContents;
    const cleanup = () => {
      input.signal.removeEventListener("abort", abort);
      ipcMain.removeListener(DESKTOP_IPC_CHANNELS.simulatorLicenseReview.response, response);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!window.isDestroyed()) window.close();
      callback();
    };
    const response = (event: Electron.IpcMainEvent, accepted: unknown) => {
      if (!sameSender(event.sender, sender) || typeof accepted !== "boolean") return;
      finish(() => resolve(accepted));
    };
    const abort = () => finish(() => reject(cancelledError()));

    ipcMain.on(DESKTOP_IPC_CHANNELS.simulatorLicenseReview.response, response);
    input.signal.addEventListener("abort", abort, { once: true });
    window.once("closed", () => finish(() => resolve(false)));
    window.once("ready-to-show", () => window.show());
    void window
      .loadURL(androidSdkLicenseReviewDataUrl(input.prompt))
      .then(() => {
        if (window.isDestroyed()) return;
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        window.webContents.on("will-redirect", (event) => event.preventDefault());
        if (!window.isVisible()) window.show();
      })
      .catch((error) => {
        finish(() => reject(error));
      });
  });
}

export function androidSdkLicenseReviewDataUrl(prompt: AndroidSdkLicensePrompt): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(androidSdkLicenseReviewHtml(prompt))}`;
}

function androidSdkLicenseReviewHtml(prompt: AndroidSdkLicensePrompt): string {
  const licenseText = escapeHtml(prompt.text);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="color-scheme" content="light dark">
  <title>Review Android SDK license</title>
  <style>
    :root { font: 14px system-ui, sans-serif; color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; display: grid; grid-template-rows: auto 1fr auto; background: Canvas; color: CanvasText; }
    header { padding: 24px 28px 14px; }
    h1 { margin: 0 0 8px; font-size: 21px; }
    p { margin: 0; color: color-mix(in srgb, CanvasText 68%, transparent); line-height: 1.45; }
    main { min-height: 0; margin: 0 28px; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 10px; overflow: auto; background: color-mix(in srgb, Canvas 94%, CanvasText); }
    pre { margin: 0; padding: 18px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 28px 24px; }
    small { max-width: 430px; color: color-mix(in srgb, CanvasText 62%, transparent); line-height: 1.4; }
    .actions { display: flex; gap: 10px; }
    button { min-height: 36px; padding: 0 16px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); font: inherit; cursor: pointer; }
    #cancel { background: Canvas; color: CanvasText; }
    #accept { border-color: #1265d6; background: #1265d6; color: white; }
    button:focus-visible { outline: 2px solid #5b9dff; outline-offset: 2px; }
  </style>
</head>
<body>
  <header>
    <h1>Android SDK license ${prompt.ordinal}</h1>
    <p>Review the official terms below. Penkra will answer this SDK Manager prompt only if you explicitly accept.</p>
  </header>
  <main><pre>${licenseText}</pre></main>
  <footer>
    <small>Accepting continues the official Android SDK setup. Cancel stops setup and leaves the Simulator recoverable.</small>
    <div class="actions"><button id="cancel" type="button">Cancel setup</button><button id="accept" type="button">Accept and continue</button></div>
  </footer>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sameSender(left: WebContents, right: WebContents): boolean {
  return left.id === right.id && !right.isDestroyed();
}

function cancelledError(): Error {
  return Object.assign(new Error("Runtime setup was cancelled."), { code: "SETUP_CANCELLED" });
}

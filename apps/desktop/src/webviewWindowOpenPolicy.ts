// FILE: webviewWindowOpenPolicy.ts
// Purpose: Denies guest window creation until a scoped owner installs its managed router.
// Layer: Desktop webview security boundary

import type { WebContents } from "electron";

/**
 * Electron creates a webview's WebContents before the renderer can bind it to an App tab and
 * page. Start every guest fail-closed so `allowpopups` cannot create an unmanaged BrowserWindow
 * during that gap. DesktopBrowserManager replaces this handler after it validates ownership.
 */
export function applyUnmanagedWebviewWindowOpenPolicy(contents: WebContents): boolean {
  if (contents.getType() !== "webview") {
    return false;
  }
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  return true;
}

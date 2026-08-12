// FILE: browserSessionPolicy.ts
// Purpose: Owns the persistent Electron browser session identity and popup security policy.
// Layer: Desktop browser infrastructure

import {
  app,
  session,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from "electron";
import { createHash } from "node:crypto";
import {
  buildAcceptLanguageHeader,
  buildChromeClientHints,
  deriveChromeUserAgent,
} from "@penkra/shared/browserSession";
import { resolveDesktopPlatformAdapter } from "./desktopPlatform";

export const BROWSER_SESSION_PARTITION = "persist:penkra-browser";

export function createScopedBrowserSessionPartition(appId: string, spaceId: string): string {
  const digest = createHash("sha256").update(`${appId}\0${spaceId}`).digest("hex").slice(0, 32);
  return `persist:penkra-browser-${digest}`;
}

function replaceRequestHeadersCaseInsensitive(
  headers: Record<string, string>,
  replacements: Record<string, string>,
): Record<string, string> {
  const replacementNamesByLower = new Set(
    Object.keys(replacements).map((name) => name.toLowerCase()),
  );
  for (const existing of Object.keys(headers)) {
    if (replacementNamesByLower.has(existing.toLowerCase())) {
      delete headers[existing];
    }
  }
  for (const [name, value] of Object.entries(replacements)) {
    headers[name] = value;
  }
  return headers;
}

export class BrowserSessionPolicy {
  private spoofedUserAgent: string | null = null;
  private readonly configuredPartitions = new Set<string>();

  private resolveUserAgent(): string {
    if (this.spoofedUserAgent === null) {
      this.spoofedUserAgent = deriveChromeUserAgent(app.userAgentFallback, [app.getName()]);
    }
    return this.spoofedUserAgent;
  }

  ensureConfigured(partition = BROWSER_SESSION_PARTITION): void {
    if (this.configuredPartitions.has(partition)) {
      return;
    }
    this.configuredPartitions.add(partition);
    try {
      const partitionSession = session.fromPartition(partition);
      const userAgent = this.resolveUserAgent();
      partitionSession.setUserAgent(userAgent);

      const clientHints = buildChromeClientHints(
        userAgent,
        resolveDesktopPlatformAdapter().platform,
      );
      const acceptLanguage = buildAcceptLanguageHeader(app.getPreferredSystemLanguages());
      partitionSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = replaceRequestHeadersCaseInsensitive(details.requestHeaders, {
          "User-Agent": userAgent,
          ...(acceptLanguage ? { "Accept-Language": acceptLanguage } : {}),
          ...(clientHints ?? {}),
        });
        callback({ requestHeaders });
      });
    } catch {
      // Session creation can race Electron readiness. Retrying the next call preserves the
      // per-WebContents fallback without permanently disabling partition configuration.
      this.configuredPartitions.delete(partition);
    }
  }

  applyUserAgent(webContents: Pick<WebContents, "setUserAgent">): void {
    webContents.setUserAgent(this.resolveUserAgent());
  }

  buildOAuthPopupWindowOptions(
    parent: BrowserWindow | null,
    partition = BROWSER_SESSION_PARTITION,
  ): BrowserWindowConstructorOptions {
    return {
      width: 480,
      height: 640,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      title: "Sign in",
      ...(parent ? { parent } : {}),
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
  }
}

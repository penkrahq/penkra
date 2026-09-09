// FILE: shellWindowRegistry.ts
// Purpose: Tracks trusted Penkra shell windows without confusing them with App/browser popups.
// Layer: Desktop main-process window coordination

import type { BrowserWindow, WebContents } from "electron";

export class ShellWindowRegistry {
  readonly #windows = new Set<BrowserWindow>();

  add(window: BrowserWindow): void {
    this.#windows.add(window);
  }

  delete(window: BrowserWindow): void {
    this.#windows.delete(window);
  }

  has(window: BrowserWindow | null | undefined): window is BrowserWindow {
    return !!window && !window.isDestroyed() && this.#windows.has(window);
  }

  hasWebContents(contents: WebContents): boolean {
    return this.list().some((window) => window.webContents === contents);
  }

  windowForWebContents(contents: WebContents): BrowserWindow | null {
    return this.list().find((window) => window.webContents === contents) ?? null;
  }

  list(): BrowserWindow[] {
    const live: BrowserWindow[] = [];
    for (const window of this.#windows) {
      if (window.isDestroyed()) {
        this.#windows.delete(window);
      } else {
        live.push(window);
      }
    }
    return live;
  }

  first(): BrowserWindow | null {
    return this.list()[0] ?? null;
  }

  resolve(focusedWindow: BrowserWindow | null): BrowserWindow | null {
    return this.has(focusedWindow) ? focusedWindow : this.first();
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const window of this.list()) {
      window.webContents.send(channel, ...args);
    }
  }
}

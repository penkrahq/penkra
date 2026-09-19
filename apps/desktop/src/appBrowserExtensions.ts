// FILE: appBrowserExtensions.ts
// Purpose: Loads host-provided extension actions into App-scoped browser sessions and presents them.
// Layer: Desktop browser infrastructure

import * as FS from "node:fs";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  nativeImage,
  screen,
  session,
  webContents as electronWebContents,
  type WebContents,
} from "electron";
import type { AppBrowserExtensionAction } from "@penkra/sdk";

interface BrowserExtensionRuntime extends AppBrowserExtensionAction {
  popupUrl: string;
}

function resolveBuiltInExtensionPath(name: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources/extensions", name),
    Path.join(__dirname, "../prod-resources/extensions", name),
    ...(typeof process.resourcesPath === "string"
      ? [
          Path.join(process.resourcesPath, "extensions", name),
          Path.join(process.resourcesPath, "resources/extensions", name),
        ]
      : []),
    Path.join(app.getAppPath(), "apps/desktop/resources/extensions", name),
  ];
  return (
    candidates.find((candidate) => FS.existsSync(Path.join(candidate, "manifest.json"))) ?? null
  );
}

function resolveManifestIconPath(
  value: string | Record<string, string> | undefined,
): string | null {
  if (typeof value === "string") return value;
  if (!value) return null;
  return (
    Object.entries(value)
      .map(([size, path]) => ({ size: Number(size), path }))
      .filter((entry) => Number.isFinite(entry.size) && typeof entry.path === "string")
      .sort((left, right) => right.size - left.size)[0]?.path ?? null
  );
}

export class AppBrowserExtensions {
  readonly #loadsByPartition = new Map<string, Promise<ReadonlyArray<BrowserExtensionRuntime>>>();
  readonly #popupByPartition = new Map<string, BrowserWindow>();
  readonly #popupTargetByPartition = new Map<string, number>();

  async list(partition: string): Promise<ReadonlyArray<AppBrowserExtensionAction>> {
    return (await this.#load(partition)).map(({ id, name, iconDataUrl }) => ({
      id,
      name,
      iconDataUrl,
    }));
  }

  async open(input: {
    partition: string;
    extensionId: string;
    target: WebContents;
    parent: BrowserWindow | null;
  }): Promise<void> {
    const extension = (await this.#load(input.partition)).find(
      (candidate) => candidate.id === input.extensionId,
    );
    if (!extension) throw new Error("Browser extension is not available in this session.");
    if (input.target.isDestroyed()) throw new Error("Browser page is no longer available.");

    input.target.focus();
    const popupUrl = new URL(extension.popupUrl);
    const extensionRoot = `${popupUrl.protocol}//${popupUrl.host}`;
    await Promise.all(
      electronWebContents
        .getAllWebContents()
        .filter(
          (contents) =>
            !contents.isDestroyed() &&
            contents.session === input.target.session &&
            contents.getURL().startsWith(`${extensionRoot}/`),
        )
        .map((contents) =>
          contents.executeJavaScript(`globalThis.__penkraActiveTabId = ${input.target.id}`, true),
        ),
    );

    this.closePopup(input.partition);
    const popup = new BrowserWindow({
      width: 272,
      height: 512,
      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      ...(input.parent && !input.parent.isDestroyed() ? { parent: input.parent } : {}),
      webPreferences: {
        partition: input.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.#popupByPartition.set(input.partition, popup);
    this.#popupTargetByPartition.set(input.partition, input.target.id);
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    popup.once("closed", () => {
      if (this.#popupByPartition.get(input.partition) === popup) {
        this.#popupByPartition.delete(input.partition);
        this.#popupTargetByPartition.delete(input.partition);
      }
    });
    popup.webContents.once("did-finish-load", () => {
      if (popup.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor).workArea;
      const bounds = popup.getBounds();
      popup.setPosition(
        Math.min(
          Math.max(display.x, cursor.x - bounds.width),
          display.x + display.width - bounds.width,
        ),
        Math.min(Math.max(display.y, cursor.y + 8), display.y + display.height - bounds.height),
        false,
      );
      popup.show();
      popup.once("blur", () => {
        if (!popup.isDestroyed()) popup.close();
      });
    });
    await popup.loadURL(extension.popupUrl);
  }

  closePopup(partition: string): void {
    const popup = this.#popupByPartition.get(partition);
    this.#popupByPartition.delete(partition);
    this.#popupTargetByPartition.delete(partition);
    if (popup && !popup.isDestroyed()) popup.destroy();
  }

  closePopupForTarget(partition: string, targetId: number): void {
    if (this.#popupTargetByPartition.get(partition) === targetId) this.closePopup(partition);
  }

  closeAllPopups(): void {
    for (const partition of [...this.#popupByPartition.keys()]) this.closePopup(partition);
  }

  #load(partition: string): Promise<ReadonlyArray<BrowserExtensionRuntime>> {
    let load = this.#loadsByPartition.get(partition);
    if (!load) {
      load = this.#loadBuiltIns(partition);
      this.#loadsByPartition.set(partition, load);
    }
    return load;
  }

  async #loadBuiltIns(partition: string): Promise<ReadonlyArray<BrowserExtensionRuntime>> {
    const extensionPath = resolveBuiltInExtensionPath("darkreader");
    if (!extensionPath) {
      console.warn("Dark Reader resources were not found; browser extensions are unavailable.");
      return [];
    }
    try {
      const loaded = await session.fromPartition(partition).extensions.loadExtension(extensionPath);
      const manifest = loaded.manifest as {
        browser_action?: {
          default_icon?: string | Record<string, string>;
          default_popup?: string;
        };
      };
      const action = manifest.browser_action;
      if (!action?.default_popup) return [];
      const iconPath = resolveManifestIconPath(action.default_icon);
      const icon = iconPath
        ? nativeImage.createFromPath(Path.join(extensionPath, iconPath))
        : nativeImage.createEmpty();
      return [
        {
          id: loaded.id,
          name: loaded.name,
          iconDataUrl: icon.isEmpty() ? "" : icon.toDataURL(),
          popupUrl: new URL(action.default_popup, loaded.url).toString(),
        },
      ];
    } catch (error) {
      console.warn("Dark Reader could not be loaded into an App browser session.", error);
      return [];
    }
  }
}

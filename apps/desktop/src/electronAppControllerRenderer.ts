// FILE: electronAppControllerRenderer.ts
// Purpose: Creates hardened unattached Electron WebContentsView instances for App controllers.
// Layer: Trusted desktop App runtime

import { WebContentsView } from "electron";

import type { AppControllerRenderer, AppControllerRendererFactory } from "./appControllerHost";
import type { AppRendererIpcBridge } from "./appRendererIpcBridge";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";
import { createAppRendererPreferences, decideAppNavigation } from "./appRuntimePolicy";

export interface ElectronAppControllerRendererFactoryOptions {
  preloadPath: string;
  ipcBridge: Pick<AppRendererIpcBridge, "waitForReady">;
  createView?: (options: ConstructorParameters<typeof WebContentsView>[0]) => WebContentsView;
  onRendererCreated?: (input: {
    appId: string;
    spaceId: string;
    rendererId: number;
  }) => (() => void) | void;
}

export class ElectronAppControllerRendererFactory implements AppControllerRendererFactory {
  readonly #preloadPath: string;
  readonly #ipcBridge: ElectronAppControllerRendererFactoryOptions["ipcBridge"];
  readonly #createView: NonNullable<ElectronAppControllerRendererFactoryOptions["createView"]>;
  readonly #onRendererCreated: NonNullable<
    ElectronAppControllerRendererFactoryOptions["onRendererCreated"]
  >;

  constructor(options: ElectronAppControllerRendererFactoryOptions) {
    this.#preloadPath = options.preloadPath;
    this.#ipcBridge = options.ipcBridge;
    this.#createView = options.createView ?? ((viewOptions) => new WebContentsView(viewOptions));
    this.#onRendererCreated = options.onRendererCreated ?? (() => undefined);
  }

  create(input: Parameters<AppControllerRendererFactory["create"]>[0]): AppControllerRenderer {
    const webPreferences = createAppRendererPreferences({
      appId: input.installedApp.appId,
      spaceId: input.spaceId,
      preloadPath: this.#preloadPath,
    });
    if (webPreferences.partition !== input.session.partition) {
      throw new Error("App controller session partition does not match its App and Space.");
    }
    const view = this.#createView({ webPreferences });
    const contents = view.webContents;
    const releaseIdentity = this.#onRendererCreated({
      appId: input.installedApp.appId,
      spaceId: input.spaceId,
      rendererId: contents.id,
    });
    let identityReleased = false;
    const releaseRendererIdentity = () => {
      if (identityReleased) return;
      identityReleased = true;
      releaseIdentity?.();
    };
    contents.once("destroyed", releaseRendererIdentity);
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => {
      if (decideAppNavigation(input.installedApp.appId, event.url).action === "deny") {
        event.preventDefault();
      }
    });

    return {
      id: contents.id,
      send: (message) => contents.send(APP_RUNTIME_IPC_CHANNELS.hostMessage, message),
      start: async (url) => {
        if (decideAppNavigation(input.installedApp.appId, url).action === "deny") {
          throw new Error("App controller entrypoint is outside its assigned origin.");
        }
        const controller = new AbortController();
        const ready = this.#ipcBridge.waitForReady(contents.id, controller.signal);
        let rejectPreloadFailure: ((error: Error) => void) | undefined;
        const preloadFailure = new Promise<never>((_resolve, reject) => {
          rejectPreloadFailure = reject;
        });
        const onPreloadError = (_event: unknown, preloadPath: string, error: Error) => {
          rejectPreloadFailure?.(
            new Error(`App controller preload failed (${preloadPath}): ${error.message}`, {
              cause: error,
            }),
          );
        };
        contents.on("preload-error", onPreloadError);
        const load = contents.loadURL(url);
        try {
          await Promise.race([Promise.all([load, ready]), preloadFailure]);
        } catch (error) {
          controller.abort(error);
          await Promise.allSettled([load, ready]);
          throw error;
        } finally {
          rejectPreloadFailure = undefined;
          contents.removeListener("preload-error", onPreloadError);
        }
      },
      destroy: () => {
        // Referencing the owning view here keeps it alive for the controller's
        // lifetime even though it is intentionally not attached to a window.
        const ownedContents = view.webContents;
        if (!ownedContents.isDestroyed()) ownedContents.close();
        releaseRendererIdentity();
      },
      onDestroyed: (listener) => {
        contents.on("destroyed", listener);
        return () => contents.removeListener("destroyed", listener);
      },
    };
  }
}

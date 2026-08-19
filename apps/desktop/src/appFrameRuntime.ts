// FILE: appFrameRuntime.ts
// Purpose: Installs the Runtime v2 SDK inside a sandboxed cross-origin App iframe.
// Layer: Browser bundle served from the trusted App package protocol

import type {
  AppRuntimeConnectMessage,
  AppRuntimeFrameMessage,
  AppRuntimeHostMessage,
} from "@penkra/contracts";
import type {
  AppAccountRealtimeConnectionState,
  AppAccountRealtimeEvent,
  AppAccountRealtimeSubscriptionOptions,
  AppBrowserSessionState,
  AppContextMenuItem,
  AppPermissionStatus,
  AppSimulatorSessionState,
  PenkraAppRuntimeApi,
  PenkraPermissionName,
} from "@penkra/sdk";

import { AppPreloadRuntime, type AppPreloadTransport } from "./appPreloadRuntime";
import { AppFrameEventRouter } from "./appFrameEventRouter";

const APP_RUNTIME_BRIDGE_PROTOCOL_VERSION = 2;
const APP_RUNTIME_CONNECT_MESSAGE = "penkra:runtime-connect";

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class AppFramePortTransport implements AppPreloadTransport {
  #port: MessagePort | null = null;
  readonly #outbox: AppRuntimeFrameMessage[] = [];
  readonly #pending = new Map<string, PendingCall>();
  readonly #hostMessageListeners = new Set<(message: unknown) => void>();
  readonly #events = new AppFrameEventRouter();
  #nextCallId = 0;

  connect(port: MessagePort): void {
    if (this.#port) throw new Error("The Penkra App bridge is already connected.");
    this.#port = port;
    this.#port.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.#accept(event.data);
    });
    this.#port.addEventListener("messageerror", () => {
      this.#failPending(new Error("The Penkra App bridge received an invalid message."));
    });
    this.#port.start();
    for (const message of this.#outbox.splice(0)) this.#port.postMessage(message);
  }

  send(message: Parameters<AppPreloadTransport["send"]>[0]): void {
    this.#post({ type: "renderer-message", message });
  }

  onHostMessage(listener: (message: unknown) => void): () => void {
    this.#hostMessageListeners.add(listener);
    return () => this.#hostMessageListeners.delete(listener);
  }

  ready(): void {
    this.#post({ type: "ready" });
  }

  tabSetRoute(input: import("@penkra/sdk").AppTabNavigationInput): Promise<void> {
    return this.#call("tab.setRoute", input);
  }

  tabGetContext(): Promise<{ threadId: string; tabId: string | null }> {
    return this.#call("tab.getContext");
  }

  queryPermission(name: PenkraPermissionName): Promise<AppPermissionStatus> {
    return this.#call("permissions.query", name);
  }

  requestPermission(name: PenkraPermissionName): Promise<AppPermissionStatus> {
    return this.#call("permissions.request", name);
  }

  getIdentity(): Promise<import("@penkra/sdk").AppIdentity> {
    return this.#call("identity.get");
  }

  getIdentityToken(input: { audience: string }): Promise<import("@penkra/sdk").AppIdentityToken> {
    return this.#call("identity.getToken", input);
  }

  accountDataRequest(
    input: Parameters<PenkraAppRuntimeApi["account"]["request"]>[0],
  ): ReturnType<PenkraAppRuntimeApi["account"]["request"]> {
    return this.#call("account.request", input);
  }

  async accountDataSubscribe(
    channel: string,
    listener: (event: AppAccountRealtimeEvent) => void,
    options?: AppAccountRealtimeSubscriptionOptions,
  ): Promise<() => void> {
    const subscriptionId = await this.#call<string>("account.subscribe", { channel });
    const eventName = `account.subscription.${subscriptionId}`;
    const unsubscribeEvent = this.#onEvent(eventName, (payload) => {
      if (!isRecord(payload)) return;
      if (payload.kind === "event") listener(payload.event as AppAccountRealtimeEvent);
      if (payload.kind === "connection-state" && options?.onConnectionStateChange) {
        options.onConnectionStateChange(payload.state as AppAccountRealtimeConnectionState);
      }
    });
    return () => {
      unsubscribeEvent();
      void this.#call("account.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  settingGet(key: string): Promise<boolean | number | string> {
    return this.#call("settings.get", key);
  }

  settingSet(input: { key: string; value: boolean | number | string }): Promise<void> {
    return this.#call("settings.set", input);
  }

  settingReset(key: string): Promise<void> {
    return this.#call("settings.reset", key);
  }

  secretGet(name: string): Promise<string | null> {
    return this.#call("secrets.get", name);
  }

  secretSet(input: { name: string; value: string }): Promise<void> {
    return this.#call("secrets.set", input);
  }

  secretDelete(name: string): Promise<void> {
    return this.#call("secrets.delete", name);
  }

  browserCall(method: string, input?: unknown): Promise<unknown> {
    return this.#call(`browser.${method}`, input);
  }

  onBrowserState(listener: (state: AppBrowserSessionState) => void): () => void {
    return this.#onEvent("browser.state", (payload) => listener(payload as AppBrowserSessionState));
  }

  onBrowserDownload(
    listener: (event: import("@penkra/sdk").AppBrowserDownloadEvent) => void,
  ): () => void {
    return this.#onEvent("browser.download", (payload) =>
      listener(payload as import("@penkra/sdk").AppBrowserDownloadEvent),
    );
  }

  simulatorCall(method: string, input?: unknown): Promise<unknown> {
    return this.#call(`simulator.${method}`, input);
  }

  onSimulatorState(listener: (state: AppSimulatorSessionState) => void): () => void {
    return this.#onEvent("simulator.state", (payload) =>
      listener(payload as AppSimulatorSessionState),
    );
  }

  networkFetch(
    input: Parameters<PenkraAppRuntimeApi["network"]["fetch"]>[0],
  ): ReturnType<PenkraAppRuntimeApi["network"]["fetch"]> {
    return this.#call("network.fetch", input);
  }

  storageCall(method: string, input?: unknown): Promise<unknown> {
    return this.#call(`storage.${method}`, input);
  }

  composerStage(
    input: import("@penkra/sdk").AppComposerStageInput,
  ): ReturnType<PenkraAppRuntimeApi["composer"]["stage"]> {
    return this.#call("composer.stage", input);
  }

  showContextMenu<T extends string>(
    items: ReadonlyArray<AppContextMenuItem<T>>,
  ): Promise<T | null> {
    return this.#call("contextMenu.show", items);
  }

  call<Result = unknown>(method: string, input?: unknown): Promise<Result> {
    return this.#call(method, input);
  }

  onEvent(name: string, listener: (payload: unknown) => void): () => void {
    return this.#onEvent(name, listener);
  }

  #call<Result = void>(method: string, input?: unknown): Promise<Result> {
    const id = `call-${++this.#nextCallId}`;
    return new Promise<Result>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as Result), reject });
      try {
        this.#post({ type: "call", id, method, ...(input === undefined ? {} : { input }) });
      } catch (error) {
        this.#pending.delete(id);
        reject(toError(error));
      }
    });
  }

  #onEvent(name: string, listener: (payload: unknown) => void): () => void {
    return this.#events.add(name, listener);
  }

  #accept(candidate: unknown): void {
    if (!isRecord(candidate) || typeof candidate.type !== "string") return;
    const message = candidate as AppRuntimeHostMessage;
    if (message.type === "host-message") {
      for (const listener of this.#hostMessageListeners) listener(message.message);
      return;
    }
    if (message.type === "event") {
      this.#events.deliver(message.name, message.payload);
      return;
    }
    if (message.type !== "call-result" && message.type !== "call-error") return;
    const pending = typeof message.id === "string" ? this.#pending.get(message.id) : undefined;
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.type === "call-result") pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.message), { code: message.code }));
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #post(message: AppRuntimeFrameMessage): void {
    if (this.#port) this.#port.postMessage(message);
    else this.#outbox.push(message);
  }
}

const transport = new AppFramePortTransport();
installAppearanceBridge(transport);
const runtime = new AppPreloadRuntime(transport);
const exposedApi = Object.assign(runtime.api, {
  installations: {
    getState: () => transport.call("installations.getState"),
    installRegistry: (input: unknown) => transport.call("installations.installRegistry", input),
    updateRegistry: (input: unknown) => transport.call("installations.updateRegistry", input),
    rollbackRegistry: (input: unknown) => transport.call("installations.rollbackRegistry", input),
    setEnabled: (input: unknown) => transport.call("installations.setEnabled", input),
    setPermission: (input: unknown) => transport.call("installations.setPermission", input),
    getSettings: (input: unknown) => transport.call("installations.getSettings", input),
    setSetting: (input: unknown) => transport.call("installations.setSetting", input),
    resetSetting: (input: unknown) => transport.call("installations.resetSetting", input),
    setSkillEnabled: (input: unknown) => transport.call("installations.setSkillEnabled", input),
    uninstall: (input: unknown) => transport.call("installations.uninstall", input),
    removeData: (input: unknown) => transport.call("installations.removeData", input),
    onState: (listener: (state: unknown) => void) =>
      transport.onEvent("installations.state", listener),
  },
  registry: {
    list: (input?: unknown) => transport.call("registry.list", input),
    get: (input: unknown) => transport.call("registry.get", input),
    getArtifact: (input: unknown) => transport.call("registry.getArtifact", input),
    getFeedback: (input: unknown) => transport.call("registry.getFeedback", input),
    setRating: (input: unknown) => transport.call("registry.setRating", input),
    setReview: (input: unknown) => transport.call("registry.setReview", input),
  },
  apps: {
    open: (input: unknown) => transport.call("apps.open", input),
  },
  files: {
    list: () => transport.call("files.list"),
    pick: (kind: unknown) => transport.call("files.pick", kind),
    revoke: (handleId: unknown) => transport.call("files.revoke", handleId),
    stat: (handleId: unknown, relativePath?: unknown) =>
      transport.call("files.stat", { handleId, relativePath }),
    listDirectory: (handleId: unknown, relativePath?: unknown) =>
      transport.call("files.listDirectory", { handleId, relativePath }),
    readText: (handleId: unknown, relativePath?: unknown) =>
      transport.call("files.readText", { handleId, relativePath }),
    readBinary: (input: unknown) => transport.call("files.readBinary", input),
    beginWrite: (input: unknown) => transport.call("files.beginWrite", input),
    writeChunk: (input: unknown) => transport.call("files.writeChunk", input),
    commitWrite: (writeId: unknown) => transport.call("files.commitWrite", { writeId }),
    abortWrite: (writeId: unknown) => transport.call("files.abortWrite", { writeId }),
    writeText: (handleId: unknown, source: unknown, relativePath?: unknown) =>
      transport.call("files.writeText", { handleId, source, relativePath }),
    createDirectory: (handleId: unknown, relativePath: unknown) =>
      transport.call("files.createDirectory", { handleId, relativePath }),
    watch: async (handleId: unknown, relativePath: unknown, listener: () => void) => {
      const watchId = await transport.call<string>("files.watch", { handleId, relativePath });
      const remove = transport.onEvent(`files.watch.${watchId}`, listener);
      return () => {
        remove();
        void transport.call("files.unwatch", { watchId }).catch(() => undefined);
      };
    },
  },
  open: (input: unknown) => transport.call("resources.open", input),
});
Object.defineProperty(globalThis, "penkra", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: exposedApi,
});
runtime.start();
runtime.markReady();

let connected = false;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (connected || event.source !== window.parent || !isConnectMessage(event.data)) return;
  const port = event.ports[0];
  if (!port) return;
  connected = true;
  transport.connect(port);
});

function isConnectMessage(value: unknown): value is AppRuntimeConnectMessage {
  return (
    isRecord(value) &&
    value.type === APP_RUNTIME_CONNECT_MESSAGE &&
    value.protocolVersion === APP_RUNTIME_BRIDGE_PROTOCOL_VERSION
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function installAppearanceBridge(frameTransport: AppFramePortTransport): void {
  const styles = new Map<string, HTMLStyleElement>();
  const setStyle = (name: string, css: unknown) => {
    if (typeof css !== "string") return;
    const style = styles.get(name) ?? document.createElement("style");
    style.dataset.penkraAppearance = name;
    style.textContent = css;
    styles.set(name, style);
    const attach = () => {
      if (!style.isConnected) (document.head ?? document.documentElement).append(style);
    };
    if (document.documentElement) attach();
    else window.addEventListener("DOMContentLoaded", attach, { once: true });
  };
  frameTransport.onEvent("appearance.theme-css", (css) => setStyle("theme", css));
  frameTransport.onEvent("appearance.typography-css", (css) => setStyle("typography", css));
}

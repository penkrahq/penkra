// FILE: electronAppTabHost.ts
// Purpose: Owns isolated App-tab renderers and attaches them to the trusted right panel.
// Layer: Trusted desktop App runtime

import { randomUUID } from "node:crypto";

import { WebContentsView, type BrowserWindow } from "electron";
import type { AppTabHandle, OperationCancellationCode } from "@penkra/sdk";
import type { DesktopAppTabClosed, DesktopAppTabDescriptor } from "@penkra/contracts";

import type { AppInstallationService } from "./appInstallationService";
import { resolveInstalledAppIconDataUrl } from "./appIconDataUrl";
import { getInstalledAppPackage, type InstalledAppPackage } from "./appInstallationState";
import type {
  AppOperationBroker,
  AppTabEndpoint,
  AppTabHost,
  OpenAppTabRequest,
} from "./appOperationBroker";
import type { AppRendererIpcBridge } from "./appRendererIpcBridge";
import type { AppRendererRpcHost, AppRendererRpcHostMessage } from "./appRendererRpc";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";
import {
  createAppDocumentUrl,
  createAppRendererPreferences,
  decideAppNavigation,
} from "./appRuntimePolicy";
import type { AppSessionManager } from "./appSessionManager";
import type { AppRuntimeDiagnosticInput } from "./appRuntimeDiagnostics";

interface AppTabRecord {
  descriptor: DesktopAppTabDescriptor;
  app: InstalledAppPackage;
  view: WebContentsView;
  attached: boolean;
  unregisterBroker: () => void;
  unregisterRpc: (reason?: OperationCancellationCode) => void;
  releaseIdentity: () => void;
  themeCssKey: string | null;
  typographyCssKey: string | null;
}

export class ElectronAppTabHost implements AppTabHost {
  readonly #window: () => BrowserWindow | null;
  readonly #installations: AppInstallationService;
  readonly #sessions: Pick<AppSessionManager, "get">;
  readonly #broker: Pick<AppOperationBroker, "registerTab">;
  readonly #rpc: Pick<AppRendererRpcHost, "registerTarget" | "request">;
  readonly #ipcBridge: Pick<AppRendererIpcBridge, "waitForReady">;
  readonly #preloadPath: string;
  readonly #onOpened: (descriptor: DesktopAppTabDescriptor) => void;
  readonly #onState: (descriptor: DesktopAppTabDescriptor) => void;
  readonly #onClosed: (descriptor: DesktopAppTabClosed) => void;
  readonly #onRendererCreated: (input: {
    appId: string;
    spaceId: string;
    threadId: string;
    tabId: string;
    rendererId: number;
  }) => (() => void) | void;
  readonly #assertAppAllowed: (app: InstalledAppPackage) => Promise<void>;
  readonly #onDiagnostic: (entry: AppRuntimeDiagnosticInput) => void;
  readonly #measureRendererMemory: (rendererId: number) => number | undefined;
  readonly #records = new Map<string, AppTabRecord>();
  #themeCss = "";
  #typographyCss = "";
  #visibleTabId: string | null = null;

  constructor(input: {
    window: () => BrowserWindow | null;
    installations: AppInstallationService;
    sessions: Pick<AppSessionManager, "get">;
    broker: Pick<AppOperationBroker, "registerTab">;
    rpc: Pick<AppRendererRpcHost, "registerTarget" | "request">;
    ipcBridge: Pick<AppRendererIpcBridge, "waitForReady">;
    preloadPath: string;
    onOpened: (descriptor: DesktopAppTabDescriptor) => void;
    onState: (descriptor: DesktopAppTabDescriptor) => void;
    onClosed?: (descriptor: DesktopAppTabClosed) => void;
    onRendererCreated?: (input: {
      appId: string;
      spaceId: string;
      threadId: string;
      tabId: string;
      rendererId: number;
    }) => (() => void) | void;
    assertAppAllowed?: (app: InstalledAppPackage) => Promise<void>;
    onDiagnostic?: (entry: AppRuntimeDiagnosticInput) => void;
    measureRendererMemory: (rendererId: number) => number | undefined;
  }) {
    this.#window = input.window;
    this.#installations = input.installations;
    this.#sessions = input.sessions;
    this.#broker = input.broker;
    this.#rpc = input.rpc;
    this.#ipcBridge = input.ipcBridge;
    this.#preloadPath = input.preloadPath;
    this.#onOpened = input.onOpened;
    this.#onState = input.onState;
    this.#onClosed = input.onClosed ?? (() => undefined);
    this.#onRendererCreated = input.onRendererCreated ?? (() => undefined);
    this.#assertAppAllowed = input.assertAppAllowed ?? (async () => undefined);
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
    this.#measureRendererMemory = input.measureRendererMemory;
  }

  async open(input: OpenAppTabRequest): Promise<AppTabHandle> {
    const handle = await this.#create(input);
    if (input.route !== "/" || input.state !== undefined) {
      await handle.navigate({
        route: input.route,
        ...(input.state === undefined ? {} : { state: input.state }),
      });
    }
    return handle;
  }

  async openForResult<Result = unknown>(input: OpenAppTabRequest): Promise<Result> {
    const handle = await this.#create(input);
    return handle.navigateForResult({
      route: input.route,
      ...(input.state === undefined ? {} : { state: input.state }),
    });
  }

  async openInstalled(input: {
    appId: string;
    spaceId: string;
    threadId: string;
    route: string;
    state?: unknown;
  }): Promise<DesktopAppTabDescriptor> {
    const app = getInstalledAppPackage(this.#installations.snapshot(), input.appId, input.spaceId);
    if (!app) throw new Error(`${input.appId} is not installed in this Space.`);
    if (!this.#installations.isActive(input.appId, input.spaceId)) {
      if (input.appId !== "com.penkra.apps")
        throw new Error(`${app.name} is disabled in this Space.`);
      await this.#installations.setEnabled({
        appId: input.appId,
        spaceId: input.spaceId,
        enabled: true,
      });
    }
    const handle = await this.open({ app, ...input });
    return this.#require(handle.id).descriptor;
  }

  async openInstalledFromRenderer(
    rendererId: number,
    input: { appId: string },
  ): Promise<DesktopAppTabDescriptor> {
    const origin = [...this.#records.values()].find(
      (record) => record.view.webContents.id === rendererId,
    );
    if (!origin) throw new Error("The originating App tab is unavailable.");
    return this.openInstalled({
      appId: input.appId,
      spaceId: origin.descriptor.spaceId,
      threadId: origin.descriptor.threadId,
      route: "/",
    });
  }

  list(): ReadonlyArray<DesktopAppTabDescriptor> {
    return [...this.#records.values()].map((record) => record.descriptor);
  }

  current(): DesktopAppTabDescriptor | null {
    return this.#visibleTabId === null
      ? null
      : (this.#records.get(this.#visibleTabId)?.descriptor ?? null);
  }

  async applyTheme(css: string): Promise<void> {
    this.#themeCss = css;
    await Promise.all(
      [...this.#records.values()].map((record) => this.#applyCss(record, "themeCssKey", css)),
    );
  }

  async applyTypography(css: string): Promise<void> {
    this.#typographyCss = css;
    await Promise.all(
      [...this.#records.values()].map((record) => this.#applyCss(record, "typographyCssKey", css)),
    );
  }

  attach(tabId: string): void {
    const record = this.#require(tabId);
    const window = this.#window();
    if (!window || window.isDestroyed()) throw new Error("The Penkra window is unavailable.");
    if (!record.attached) {
      window.contentView.addChildView(record.view);
      record.attached = true;
    }
  }

  setBounds(tabId: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const record = this.#require(tabId);
    record.view.setBounds(normalizeBounds(bounds));
  }

  rendererBounds(
    rendererId: number,
  ): { x: number; y: number; width: number; height: number } | null {
    const record = [...this.#records.values()].find(
      (candidate) => candidate.view.webContents.id === rendererId,
    );
    return record ? record.view.getBounds() : null;
  }

  rendererId(tabId: string): number {
    return this.#require(tabId).view.webContents.id;
  }

  setVisible(tabId: string, visible: boolean): void {
    const record = this.#require(tabId);
    record.view.setVisible?.(visible);
    if (visible) {
      this.#visibleTabId = tabId;
    } else {
      if (this.#visibleTabId === tabId) this.#visibleTabId = null;
      record.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  async navigate(tabId: string, input: { route: string; state?: unknown }): Promise<void> {
    await this.#request(tabId, "tab.navigate", input);
  }

  close(tabId: string, reason: OperationCancellationCode = "tab-closed"): void {
    const record = this.#records.get(tabId);
    if (!record) return;
    if (this.#visibleTabId === tabId) this.#visibleTabId = null;
    this.#records.delete(tabId);
    record.unregisterBroker();
    record.unregisterRpc(reason);
    record.releaseIdentity();
    const window = this.#window();
    if (record.attached && window && !window.isDestroyed())
      window.contentView.removeChildView(record.view);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    this.#onClosed({ id: tabId, threadId: record.descriptor.threadId });
  }

  closeAll(reason: OperationCancellationCode = "host-stopped"): void {
    for (const tabId of [...this.#records.keys()]) this.close(tabId, reason);
  }

  closeForAppSpace(
    appId: string,
    spaceId: string,
    reason: OperationCancellationCode = "app-disabled",
  ): void {
    for (const [tabId, record] of this.#records) {
      if (record.app.appId === appId && record.descriptor.spaceId === spaceId)
        this.close(tabId, reason);
    }
  }

  async #create(input: OpenAppTabRequest): Promise<AppTabHandle> {
    const openedAt = performance.now();
    await this.#assertAppAllowed(input.app);
    const activeSession = this.#sessions.get(input.app.appId, input.spaceId);
    if (!activeSession) throw new Error(`${input.app.name} is not active in this Space.`);
    const id = randomUUID();
    const view = new WebContentsView({
      webPreferences: createAppRendererPreferences({
        appId: input.app.appId,
        spaceId: input.spaceId,
        preloadPath: this.#preloadPath,
      }),
    });
    const contents = view.webContents;
    const releaseRendererIdentity = this.#onRendererCreated({
      appId: input.app.appId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      tabId: id,
      rendererId: contents.id,
    });
    let identityReleased = false;
    const releaseIdentity = () => {
      if (identityReleased) return;
      identityReleased = true;
      releaseRendererIdentity?.();
    };
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => {
      if (decideAppNavigation(input.app.appId, event.url).action === "deny") event.preventDefault();
    });
    const descriptor: DesktopAppTabDescriptor = {
      id,
      appId: input.app.appId,
      slug: input.app.slug,
      name: input.app.name,
      iconDataUrl: await resolveInstalledAppIconDataUrl(input.app),
      spaceId: input.spaceId,
      threadId: input.threadId,
      route: input.route,
      status: "loading",
    };
    const target = {
      id: contents.id,
      send: (message: AppRendererRpcHostMessage) =>
        contents.send(APP_RUNTIME_IPC_CHANNELS.hostMessage, message),
    };
    const unregisterRpc = this.#rpc.registerTarget(target);
    const endpoint: AppTabEndpoint = {
      id,
      appId: input.app.appId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      navigate: (navigation) => this.#request(id, "tab.navigate", navigation),
      navigateForResult: (navigation) => this.#request(id, "tab.navigate-for-result", navigation),
      invoke: (request) => this.#request(id, "tab.invoke", request),
    };
    const unregisterBroker = this.#broker.registerTab(endpoint);
    const record: AppTabRecord = {
      descriptor,
      app: input.app,
      view,
      attached: false,
      unregisterBroker,
      unregisterRpc,
      releaseIdentity,
      themeCssKey: null,
      typographyCssKey: null,
    };
    this.#records.set(id, record);
    this.#onOpened(record.descriptor);
    this.#onDiagnostic({
      kind: "tab-opened",
      appId: input.app.appId,
      spaceId: input.spaceId,
      tabId: id,
    });
    contents.once("destroyed", () => {
      releaseIdentity?.();
      if (this.#records.has(id)) this.close(id, "host-stopped");
    });
    contents.on("unresponsive", () => {
      this.#onDiagnostic({
        kind: "tab-unresponsive",
        appId: input.app.appId,
        spaceId: input.spaceId,
        tabId: id,
      });
    });
    contents.on("responsive", () => {
      this.#onDiagnostic({
        kind: "tab-responsive",
        appId: input.app.appId,
        spaceId: input.spaceId,
        tabId: id,
      });
    });
    contents.on("render-process-gone", (_event, details) => {
      record.descriptor = { ...record.descriptor, status: "crashed" };
      this.#onState(record.descriptor);
      this.#onDiagnostic({
        kind: "tab-crashed",
        appId: input.app.appId,
        spaceId: input.spaceId,
        tabId: id,
        message: `${details.reason} (exit ${details.exitCode})`,
      });
    });
    try {
      const ready = this.#ipcBridge.waitForReady(contents.id);
      await Promise.all([
        contents.loadURL(createAppDocumentUrl(input.app.appId, input.app.manifest.entrypoints.app)),
        ready,
      ]);
      record.descriptor = { ...record.descriptor, status: "ready" };
      if (this.#themeCss) await this.#applyCss(record, "themeCssKey", this.#themeCss);
      if (this.#typographyCss) {
        await this.#applyCss(record, "typographyCssKey", this.#typographyCss);
      }
      const memoryBytes = this.#measureRendererMemory(contents.id);
      this.#onDiagnostic({
        kind: "tab-ready",
        appId: input.app.appId,
        spaceId: input.spaceId,
        tabId: id,
        durationMs: Math.round(performance.now() - openedAt),
        ...(memoryBytes === undefined ? {} : { memoryBytes }),
      });
      this.#onState(record.descriptor);
      return endpoint;
    } catch (error) {
      this.close(id, "host-stopped");
      throw error;
    }
  }

  #request<Result>(
    tabId: string,
    method: "tab.invoke" | "tab.navigate" | "tab.navigate-for-result",
    input: unknown,
  ): Promise<Result> {
    return this.#rpc.request<Result>(this.#require(tabId).view.webContents.id, method, input);
  }

  async #applyCss(
    record: AppTabRecord,
    keyName: "themeCssKey" | "typographyCssKey",
    css: string,
  ): Promise<void> {
    const nextKey = await record.view.webContents.insertCSS(css, { cssOrigin: "author" });
    const previousKey = record[keyName];
    record[keyName] = nextKey;
    if (previousKey) await record.view.webContents.removeInsertedCSS(previousKey);
  }

  #require(tabId: string): AppTabRecord {
    const record = this.#records.get(tabId);
    if (!record) throw new Error(`App tab ${tabId} is unavailable.`);
    return record;
  }
}

function normalizeBounds(bounds: { x: number; y: number; width: number; height: number }) {
  for (const value of Object.values(bounds)) {
    if (!Number.isFinite(value)) throw new Error("App tab bounds must be finite numbers.");
  }
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

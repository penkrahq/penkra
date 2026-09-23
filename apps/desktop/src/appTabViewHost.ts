// FILE: appTabViewHost.ts
// Purpose: Owns isolated App document and hosted-page views in the trusted right dock.
// Layer: Trusted desktop App runtime

import { randomUUID } from "node:crypto";

import {
  BrowserWindow,
  WebContentsView,
  type NativeImage,
  type Rectangle,
  type WebContents,
  type BrowserWindowConstructorOptions,
} from "electron";
import type {
  AppBrowserExtensionAction,
  AppBrowserPage,
  AppBrowserSessionState,
  AppTabHandle,
  OperationCancellationCode,
} from "@penkra/sdk";
import type {
  DesktopAppTabClosed,
  DesktopAppTabDescriptor,
  DesktopAppTabOpened,
  DesktopAppTabPresentation,
} from "@penkra/contracts";

import type { AppInstallationService } from "./appInstallationService";
import { AppBrowserExtensions } from "./appBrowserExtensions";
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
import type { AppSessionManager } from "./appSessionManager";
import type { AppRuntimeDiagnosticInput } from "./appRuntimeDiagnostics";
import { APP_RUNTIME_IPC_CHANNELS } from "./ipcChannels";
import {
  createAppDocumentUrlForOrigin,
  createAppRendererPreferences,
  decideAppSpaceNavigation,
} from "./appRuntimePolicy";
import { createScopedBrowserSessionPartition } from "./browserSessionPolicy";
import { BrowserSessionPolicy } from "./browserSessionPolicy";
import {
  BROWSER_BLANK_URL,
  classifyBrowserWindowOpen,
  normalizeBrowserUrlInput,
} from "@penkra/shared/browserSession";
import { ProtectedPublisher } from "./protectedPublisher";
import { RollbackScope } from "./rollbackScope";
import {
  appRuntimeFailureDto,
  appRuntimeGroupFailure,
  appRuntimeOperationFailure,
} from "./appRuntimeFailure";

export interface AppTabGenerationOwner {
  appId: string;
  spaceId: string;
  deckId: string;
  threadId: string;
  tabId: string;
  rendererId: number;
}

export interface AppTabLogicalOwner {
  appId: string;
  spaceId: string;
  deckId: string;
  threadId: string;
  tabId: string;
}

export interface AppTabAuthority {
  /** Synchronously detaches authority belonging to one exact App renderer generation. */
  retireGeneration(owner: AppTabGenerationOwner): void;
  /** Retires resources owned by the stable logical tab after it is actually closed. */
  retireTab(owner: AppTabLogicalOwner): void;
}

interface AppTabRecord {
  descriptor: DesktopAppTabDescriptor;
  endpoint: AppTabEndpoint;
  app: InstalledAppPackage;
  rendererId: number;
  appView: WebContentsView;
  page: HostedPage | null;
  popupOpeners: HostedPage[];
  ownerWindowId: number | null;
  bounds: Rectangle;
  dockWidth: number;
  rightInset: number;
  bottom: number;
  pageTop: number;
  browserVersion: number;
  lastFrame: NativeImage | null;
  freezeDepth: number;
  visibleRequested: boolean;
  ownerWindowVisible: boolean;
  hiddenByDock: boolean;
  animationTimer: ReturnType<typeof setTimeout> | null;
  unregisterBroker: () => void;
  unregisterRpc: (reason?: OperationCancellationCode) => void;
  releaseIdentity: () => void;
  navigation: { route: string; state?: unknown };
  presentationIconSource: "hosted-page" | { dataUrl: string } | null;
  openedAt: number;
  themeCssKey: string | null;
  typographyCssKey: string | null;
}

interface HostedPage {
  id: string;
  view: WebContentsView;
  state: AppBrowserPage;
  disposers: Array<() => void>;
  pendingLoad: Promise<void> | null;
  isPopup: boolean;
}

interface AppTabWindowPresentation {
  bounds: Rectangle;
  deckId: string;
  threadId: string;
  selectedAt: number;
  visible: boolean;
  windowVisible: boolean;
}

export function shouldApplyAppTabHide(
  current: Pick<AppTabWindowPresentation, "selectedAt" | "visible"> | undefined,
  requestedSelectedAt: number | null,
): boolean {
  return current?.visible !== true && (current?.selectedAt ?? null) === requestedSelectedAt;
}

export function shouldNotifyAppTabClosed(reason: OperationCancellationCode): boolean {
  // Host shutdown and package replacement retire renderers without deleting the user's logical
  // tabs. Keeping the shell panes lets the next renderer attach to the same stable tab IDs.
  return reason !== "host-stopped" && reason !== "app-updated";
}

function shouldRetireLogicalAppTab(reason: OperationCancellationCode): boolean {
  return reason !== "app-updated";
}

export interface AppUpdateTabSnapshot {
  id: string;
  deckId: string;
  threadId: string;
  route: string;
  state?: unknown;
}

export interface AppTabReplicaFrame {
  appFrameDataUrl: string;
  pageFrameDataUrl?: string;
  pageTop: number;
}

export function resolveAppTabPresentationMode(input: {
  ownsWindow: boolean;
  presentationVisible: boolean;
  windowVisible: boolean;
  hasReplica: boolean;
}): DesktopAppTabPresentation["mode"] {
  if (input.ownsWindow && input.presentationVisible && input.windowVisible) return "live";
  if (input.presentationVisible && input.hasReplica) return "replica";
  return "hidden";
}

export function shouldKeepNativeAppViewVisible(input: {
  visibleRequested: boolean;
  freezeDepth: number;
}): boolean {
  return input.visibleRequested && input.freezeDepth === 0;
}

export function shouldPresentAppView(input: {
  selected: boolean;
  attached: boolean;
  windowVisible: boolean;
  painted: boolean;
  threadOnScreen: boolean;
  bounds: Rectangle;
}): boolean {
  return (
    input.selected &&
    input.attached &&
    input.windowVisible &&
    input.painted &&
    input.threadOnScreen &&
    input.bounds.width > 0 &&
    input.bounds.height > 0
  );
}

export function shouldKeepPresentationAnimation(input: {
  animating: boolean;
  ownerWindowId: number | null;
  requestedWindowId: number;
  currentBounds: Rectangle;
  requestedBounds: Rectangle;
}): boolean {
  return (
    input.animating &&
    input.ownerWindowId === input.requestedWindowId &&
    rectanglesEqual(input.currentBounds, input.requestedBounds)
  );
}

export function resizedAppTabBounds(input: {
  bounds: Rectangle;
  dockWidth: number;
  rightInset: number;
  bottom: number;
  width: number;
  height: number;
}): Rectangle {
  const windowWidth = Math.max(1, input.width);
  const rightInset = Math.max(0, Math.min(windowWidth - 1, Math.round(input.rightInset)));
  const width = Math.max(1, Math.min(Math.round(input.dockWidth), windowWidth - rightInset));
  return {
    x: windowWidth - rightInset - width,
    y: input.bounds.y,
    width,
    height: Math.max(1, input.height - input.bottom - input.bounds.y),
  };
}

let appTabHostTraceSequence = 0;

function traceAppTabHost(event: string, details: Record<string, unknown> = {}): void {
  console.info("[app-tab-host]", {
    ...details,
    sequence: ++appTabHostTraceSequence,
    monotonicMs: Math.round(performance.now()),
    event,
  });
}

export class AppTabViewHost implements AppTabHost {
  readonly #installations: AppInstallationService;
  readonly #sessions: Pick<AppSessionManager, "get">;
  readonly #broker: Pick<AppOperationBroker, "registerTab">;
  readonly #rpc: Pick<
    AppRendererRpcHost,
    "registerTarget" | "request" | "acceptResponse" | "acceptContextCall"
  >;
  readonly #ipcBridge: Pick<AppRendererIpcBridge, "waitForReady">;
  readonly #preloadPath: string;
  readonly #windowById: (windowId: number) => BrowserWindow | null;
  readonly #onBeforeInput: (event: Electron.Event, input: Electron.Input) => void;
  readonly #opened: ProtectedPublisher<DesktopAppTabOpened>;
  readonly #state: ProtectedPublisher<DesktopAppTabDescriptor>;
  readonly #closed: ProtectedPublisher<DesktopAppTabClosed>;
  readonly #registerRendererIdentity: (input: {
    appId: string;
    spaceId: string;
    deckId: string;
    threadId: string;
    tabId: string;
    rendererId: number;
  }) => (() => void) | void;
  readonly #authority: AppTabAuthority;
  readonly #assertAppAllowed: (app: InstalledAppPackage) => Promise<void>;
  readonly #resolveIconDataUrl: typeof resolveInstalledAppIconDataUrl;
  readonly #diagnostics: ProtectedPublisher<AppRuntimeDiagnosticInput>;
  readonly #records = new Map<string, AppTabRecord>();
  readonly #presentationsByTabId = new Map<string, Map<number, AppTabWindowPresentation>>();
  readonly #replicaFrameByTabId = new Map<string, AppTabReplicaFrame>();
  readonly #overlayDepthByWindowId = new Map<number, number>();
  readonly #browserSessionPolicy = new BrowserSessionPolicy();
  readonly #browserExtensions = new AppBrowserExtensions();
  readonly #onPresentation: (windowId: number, state: DesktopAppTabPresentation) => void;
  #selectionSequence = 0;
  #themeCss = "";
  #typographyCss = "";
  #lastVisibleTabId: string | null = null;

  constructor(input: {
    installations: AppInstallationService;
    sessions: Pick<AppSessionManager, "get">;
    broker: Pick<AppOperationBroker, "registerTab">;
    rpc: Pick<
      AppRendererRpcHost,
      "registerTarget" | "request" | "acceptResponse" | "acceptContextCall"
    >;
    ipcBridge: Pick<AppRendererIpcBridge, "waitForReady">;
    preloadPath: string;
    windowById: (windowId: number) => BrowserWindow | null;
    onBeforeInput?: (event: Electron.Event, input: Electron.Input) => void;
    onOpened: (descriptor: DesktopAppTabOpened) => void;
    onState: (descriptor: DesktopAppTabDescriptor) => void;
    onClosed?: (descriptor: DesktopAppTabClosed) => void;
    onPresentation?: (windowId: number, state: DesktopAppTabPresentation) => void;
    registerRendererIdentity?: (input: {
      appId: string;
      spaceId: string;
      deckId: string;
      threadId: string;
      tabId: string;
      rendererId: number;
    }) => (() => void) | void;
    authority?: AppTabAuthority;
    assertAppAllowed?: (app: InstalledAppPackage) => Promise<void>;
    resolveIconDataUrl?: typeof resolveInstalledAppIconDataUrl;
    onDiagnostic?: (entry: AppRuntimeDiagnosticInput) => void;
    onNotificationError?: (error: unknown) => void;
  }) {
    this.#installations = input.installations;
    this.#sessions = input.sessions;
    this.#broker = input.broker;
    this.#rpc = input.rpc;
    this.#ipcBridge = input.ipcBridge;
    this.#preloadPath = input.preloadPath;
    this.#windowById = input.windowById;
    this.#onBeforeInput = input.onBeforeInput ?? (() => undefined);
    const onNotificationError =
      input.onNotificationError ??
      ((error: unknown) => console.error("[penkra-app] App tab notification failed.", error));
    this.#opened = new ProtectedPublisher(onNotificationError);
    this.#opened.subscribe(input.onOpened);
    this.#state = new ProtectedPublisher(onNotificationError);
    this.#state.subscribe(input.onState);
    this.#closed = new ProtectedPublisher(onNotificationError);
    this.#closed.subscribe(input.onClosed ?? (() => undefined));
    this.#onPresentation = input.onPresentation ?? (() => undefined);
    this.#registerRendererIdentity = input.registerRendererIdentity ?? (() => undefined);
    this.#authority = input.authority ?? {
      retireGeneration: () => undefined,
      retireTab: () => undefined,
    };
    this.#assertAppAllowed = input.assertAppAllowed ?? (async () => undefined);
    this.#resolveIconDataUrl = input.resolveIconDataUrl ?? resolveInstalledAppIconDataUrl;
    this.#diagnostics = new ProtectedPublisher(onNotificationError);
    this.#diagnostics.subscribe(input.onDiagnostic ?? (() => undefined));
  }

  async open(input: OpenAppTabRequest & { tabId?: string }): Promise<AppTabHandle> {
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
    tabId?: string;
    appId: string;
    spaceId: string;
    deckId: string;
    threadId: string;
    route: string;
    state?: unknown;
  }): Promise<DesktopAppTabDescriptor> {
    return this.#openInstalled(input, false);
  }

  async #openInstalled(
    input: {
      tabId?: string;
      appId: string;
      spaceId: string;
      deckId: string;
      threadId: string;
      route: string;
      state?: unknown;
    },
    deferNavigation: boolean,
  ): Promise<DesktopAppTabDescriptor> {
    const app = getInstalledAppPackage(this.#installations.snapshot(), input.appId, input.spaceId);
    if (!app) throw new Error(`${input.appId} is not installed in this Space.`);
    if (!this.#installations.isActive(input.appId, input.spaceId)) {
      if (input.appId === "com.penkra.apps") {
        await this.#installations.setEnabled({
          appId: input.appId,
          spaceId: input.spaceId,
          enabled: true,
        });
      } else {
        // Enabled Apps are activated lazily after launch. Opening their UI must
        // reconcile persisted enablement with the live controller just like an
        // operation invocation does.
        await this.#installations.ensureActive(input.appId, input.spaceId);
      }
    }
    const handle = deferNavigation
      ? await this.#create({ app, ...input })
      : await this.open({ app, ...input });
    if (deferNavigation && (input.route !== "/" || input.state !== undefined)) {
      const startedAt = performance.now();
      const rendererId = this.#require(handle.id).rendererId;
      void handle
        .navigate({
          route: input.route,
          ...(input.state === undefined ? {} : { state: input.state }),
        })
        .then(
          () =>
            this.#diagnostics.publish({
              kind: "tab-navigation-restored",
              appId: app.appId,
              spaceId: input.spaceId,
              tabId: handle.id,
              durationMs: Math.round(performance.now() - startedAt),
              message: input.route,
            }),
          (error: unknown) => {
            this.#diagnostics.publish({
              kind: "tab-navigation-restore-failed",
              appId: app.appId,
              spaceId: input.spaceId,
              tabId: handle.id,
              durationMs: Math.round(performance.now() - startedAt),
              message: safeErrorMessage(error),
              failure: appRuntimeFailureDto(
                appRuntimeOperationFailure({
                  message: "App tab route restoration failed.",
                  primary: error,
                }),
              ),
            });
            this.#closeMatchingRenderer(handle.id, rendererId);
          },
        );
    }
    return this.#require(handle.id).descriptor;
  }

  async openInstalledFromRenderer(
    rendererId: number,
    input: { appId: string },
  ): Promise<DesktopAppTabDescriptor> {
    const origin = [...this.#records.values()].find((record) => record.rendererId === rendererId);
    if (!origin) throw new Error("The originating App tab is unavailable.");
    const existing = this.presentExisting({
      appId: input.appId,
      spaceId: origin.descriptor.spaceId,
      deckId: origin.descriptor.deckId,
    });
    if (existing) return this.#require(existing.id).descriptor;
    return this.openInstalled({
      appId: input.appId,
      spaceId: origin.descriptor.spaceId,
      deckId: origin.descriptor.deckId,
      threadId: origin.descriptor.threadId,
      route: "/",
    });
  }

  async openSiblingFromRenderer(
    rendererId: number,
    input: { route: string; state?: unknown },
  ): Promise<{ tabId: string }> {
    const origin = [...this.#records.values()].find((record) => record.rendererId === rendererId);
    if (!origin) throw new Error("The originating App tab is unavailable.");
    return this.openSibling(origin.descriptor.id, input);
  }

  async openSibling(
    tabId: string,
    input: { route: string; state?: unknown },
  ): Promise<{ tabId: string }> {
    const origin = this.#require(tabId);
    const descriptor = await this.openInstalled({
      appId: origin.app.appId,
      spaceId: origin.descriptor.spaceId,
      deckId: origin.descriptor.deckId,
      threadId: origin.descriptor.threadId,
      route: input.route,
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    return { tabId: descriptor.id };
  }

  presentExisting(input: {
    appId: string;
    spaceId: string;
    deckId: string;
  }): AppTabEndpoint | null {
    const record = [...this.#records.values()].find(
      (candidate) =>
        candidate.app.appId === input.appId &&
        candidate.descriptor.spaceId === input.spaceId &&
        candidate.descriptor.deckId === input.deckId,
    );
    if (!record) return null;
    this.present(record.descriptor.id);
    return record.endpoint;
  }

  list(): ReadonlyArray<DesktopAppTabDescriptor> {
    return [...this.#records.values()].map((record) => record.descriptor);
  }

  has(tabId: string): boolean {
    return this.#records.has(tabId);
  }

  listFor(spaceId: string, deckId: string): ReadonlyArray<DesktopAppTabDescriptor> {
    return this.list().filter(
      (descriptor) => descriptor.spaceId === spaceId && descriptor.deckId === deckId,
    );
  }

  current(): DesktopAppTabDescriptor | null {
    return this.#lastVisibleTabId === null
      ? null
      : (this.#records.get(this.#lastVisibleTabId)?.descriptor ?? null);
  }

  currentFor(spaceId: string, deckId: string, windowId?: number): DesktopAppTabDescriptor | null {
    for (const record of [...this.#records.values()].reverse()) {
      if (
        record.descriptor.spaceId === spaceId &&
        record.descriptor.deckId === deckId &&
        (windowId === undefined || record.ownerWindowId === windowId)
      ) {
        return record.descriptor;
      }
    }
    return null;
  }

  async presentInWindow(input: {
    tabId: string;
    deckId: string;
    threadId: string;
    windowId: number;
    bounds: Rectangle;
    animate?: boolean;
    animationStartedAtEpochMs?: number;
  }): Promise<void> {
    const record = this.#require(input.tabId);
    const window = this.#windowById(input.windowId);
    traceAppTabHost("present-started", {
      tabId: input.tabId,
      windowId: input.windowId,
      deckId: input.deckId,
      threadId: input.threadId,
      ownerWindowId: record.ownerWindowId,
      freezeDepth: record.freezeDepth,
      appViewVisible: record.appView.getVisible(),
    });
    if (!window || window.isDestroyed()) {
      traceAppTabHost("present-skipped", {
        tabId: input.tabId,
        windowId: input.windowId,
        reason: "window-unavailable",
      });
      return;
    }
    const content = window.getContentBounds();
    const width = Math.max(1, Math.min(Math.round(input.bounds.width), content.width));
    const y = Math.max(0, Math.min(Math.round(input.bounds.y), content.height - 1));
    const bounds = {
      x: content.width - width,
      y,
      width,
      height: Math.max(1, content.height - y),
    };

    for (const other of this.#records.values()) {
      if (other === record) continue;
      const presentation = this.#presentationsByTabId.get(other.descriptor.id)?.get(input.windowId);
      if (!presentation?.visible) continue;
      presentation.visible = false;
      if (other.ownerWindowId === input.windowId)
        this.hide(other.descriptor.id, false, input.windowId);
      this.#emitPresentation(other.descriptor.id);
    }

    if (record.ownerWindowId !== null && record.ownerWindowId !== input.windowId) {
      try {
        this.#replicaFrameByTabId.set(input.tabId, await this.captureReplica(input.tabId));
      } catch (error) {
        console.warn(
          `[app-tab] Could not capture replica for ${input.tabId}: ${safeErrorMessage(error)}`,
        );
      }
    }
    let presentations = this.#presentationsByTabId.get(input.tabId);
    if (!presentations) {
      presentations = new Map();
      this.#presentationsByTabId.set(input.tabId, presentations);
    }
    presentations.set(input.windowId, {
      bounds,
      deckId: input.deckId,
      threadId: input.threadId,
      selectedAt: ++this.#selectionSequence,
      visible: true,
      windowVisible: window.isVisible() && !window.isMinimized(),
    });
    this.setContext(input.tabId, {
      deckId: input.deckId,
      threadId: input.threadId,
    });
    this.present(
      input.tabId,
      input.windowId,
      bounds,
      input.animate === true,
      input.animationStartedAtEpochMs,
    );
    traceAppTabHost("present-applied", {
      tabId: input.tabId,
      deckId: input.deckId,
      threadId: input.threadId,
      windowId: input.windowId,
      ownerWindowId: record.ownerWindowId,
      selectedAt: presentations.get(input.windowId)?.selectedAt ?? null,
      bounds,
      animate: input.animate === true,
      windowVisible: window.isVisible(),
      windowMinimized: window.isMinimized(),
      appViewVisible: record.appView.getVisible(),
      appViewIndex: window.contentView.children.indexOf(record.appView),
      childViewCount: window.contentView.children.length,
      hostedPageVisible: record.page?.view.getVisible() ?? false,
      appViewLoading: record.appView.webContents.isLoading(),
      appViewCrashed: record.appView.webContents.isCrashed(),
      hostedPageLoading: record.page?.view.webContents.isLoading() ?? false,
    });
    this.#emitPresentation(input.tabId);
  }

  async hideInWindow(tabId: string, windowId: number, animate = false): Promise<void> {
    const record = this.#require(tabId);
    const presentation = this.#presentationsByTabId.get(tabId)?.get(windowId);
    const selectedAt = presentation?.selectedAt ?? null;
    if (presentation) presentation.visible = false;
    traceAppTabHost("hide-requested", {
      tabId,
      windowId,
      ownerWindowId: record.ownerWindowId,
      hadPresentation: presentation !== undefined,
      selectedAt,
      animate,
      appViewVisible: record.appView.getVisible(),
    });
    if (record.ownerWindowId !== windowId) {
      traceAppTabHost("hide-skipped", { tabId, windowId, reason: "owner-window-mismatch" });
      this.#emitPresentation(tabId);
      return;
    }
    traceAppTabHost("hide-replica-capture-started", { tabId, windowId, selectedAt });
    try {
      this.#replicaFrameByTabId.set(tabId, await this.captureReplica(tabId));
      traceAppTabHost("hide-replica-capture-completed", { tabId, windowId, selectedAt });
    } catch (error) {
      traceAppTabHost("hide-replica-capture-failed", {
        tabId,
        windowId,
        selectedAt,
        error: safeErrorMessage(error),
      });
      // A hidden/closing surface may no longer be paintable.
    }
    const currentPresentation = this.#presentationsByTabId.get(tabId)?.get(windowId);
    if (!shouldApplyAppTabHide(currentPresentation, selectedAt)) {
      traceAppTabHost("hide-superseded", {
        tabId,
        windowId,
        requestedSelectedAt: selectedAt,
        currentSelectedAt: currentPresentation?.selectedAt ?? null,
        currentVisible: currentPresentation?.visible ?? false,
      });
      this.#emitPresentation(tabId);
      return;
    }
    this.hide(tabId, animate, windowId);
    traceAppTabHost("hide-applied", {
      tabId,
      windowId,
      selectedAt,
      animate,
      appViewVisible: record.appView.getVisible(),
    });
    const fallback = this.#latestVisiblePresentation(tabId, windowId);
    if (fallback) {
      const [fallbackWindowId, value] = fallback;
      await this.presentInWindow({
        tabId,
        windowId: fallbackWindowId,
        deckId: value.deckId,
        threadId: value.threadId,
        bounds: value.bounds,
      });
    } else {
      this.#emitPresentation(tabId);
    }
  }

  async setWindowVisibility(windowId: number, visible: boolean): Promise<void> {
    traceAppTabHost("window-visibility-started", { windowId, visible });
    for (const [tabId, presentations] of this.#presentationsByTabId) {
      const presentation = presentations.get(windowId);
      if (!presentation) continue;
      presentation.windowVisible = visible;
      const record = this.#records.get(tabId);
      if (!record) continue;
      traceAppTabHost("window-visibility-tab", {
        tabId,
        windowId,
        visible,
        presentationVisible: presentation.visible,
        ownerWindowId: record.ownerWindowId,
        appViewVisible: record.appView.getVisible(),
      });
      if (!visible && record.ownerWindowId === windowId) {
        traceAppTabHost("window-hide-replica-capture-started", { tabId, windowId });
        try {
          this.#replicaFrameByTabId.set(tabId, await this.captureReplica(tabId));
          traceAppTabHost("window-hide-replica-capture-completed", { tabId, windowId });
        } catch (error) {
          traceAppTabHost("window-hide-replica-capture-failed", {
            tabId,
            windowId,
            error: safeErrorMessage(error),
          });
          // The window can become hidden before Chromium produces a frame.
        }
        const fallback = this.#latestVisiblePresentation(tabId, windowId);
        if (fallback) {
          const [nextWindowId, value] = fallback;
          await this.presentInWindow({
            tabId,
            windowId: nextWindowId,
            deckId: value.deckId,
            threadId: value.threadId,
            bounds: value.bounds,
          });
        }
      } else if (visible && presentation.visible) {
        const latest = this.#latestVisiblePresentation(tabId);
        if (latest?.[0] === windowId && record.ownerWindowId !== windowId) {
          await this.presentInWindow({
            tabId,
            windowId,
            deckId: presentation.deckId,
            threadId: presentation.threadId,
            bounds: presentation.bounds,
          });
        }
      }
      this.#emitPresentation(tabId);
    }
    if (visible) this.showWindow(windowId);
    else this.hideWindow(windowId);
    traceAppTabHost("window-visibility-completed", { windowId, visible });
  }

  async focusWindow(windowId: number): Promise<void> {
    const visible = [...this.#presentationsByTabId.entries()]
      .flatMap(([tabId, presentations]) => {
        const presentation = presentations.get(windowId);
        return presentation?.visible ? [{ tabId, presentation }] : [];
      })
      .sort((left, right) => right.presentation.selectedAt - left.presentation.selectedAt)[0];
    if (!visible || !this.#records.has(visible.tabId)) return;
    visible.presentation.windowVisible = true;
    if (this.#require(visible.tabId).ownerWindowId === windowId) return;
    await this.presentInWindow({
      tabId: visible.tabId,
      windowId,
      deckId: visible.presentation.deckId,
      threadId: visible.presentation.threadId,
      bounds: visible.presentation.bounds,
    });
  }

  async releaseWindowPresentation(windowId: number): Promise<void> {
    const owned = [...this.#records.values()]
      .filter((record) => record.ownerWindowId === windowId)
      .map((record) => record.descriptor.id);
    for (const presentations of this.#presentationsByTabId.values()) presentations.delete(windowId);
    this.#overlayDepthByWindowId.delete(windowId);
    this.releaseWindow(windowId);
    for (const tabId of owned) {
      const fallback = this.#latestVisiblePresentation(tabId, windowId);
      if (fallback) {
        const [nextWindowId, value] = fallback;
        await this.presentInWindow({
          tabId,
          windowId: nextWindowId,
          deckId: value.deckId,
          threadId: value.threadId,
          bounds: value.bounds,
        });
      } else {
        this.#emitPresentation(tabId);
      }
    }
  }

  setOverlayActive(windowId: number, active: boolean): void {
    const tabId = this.tabForWindow(windowId)?.id;
    if (!tabId) return;
    const depth = this.#overlayDepthByWindowId.get(windowId) ?? 0;
    traceAppTabHost("overlay-state", {
      tabId,
      windowId,
      active,
      previousDepth: depth,
      nextDepth: active ? depth + 1 : Math.max(0, depth - 1),
    });
    if (active) {
      this.#overlayDepthByWindowId.set(windowId, depth + 1);
      if (depth === 0) void this.freeze(tabId);
      return;
    }
    const next = Math.max(0, depth - 1);
    if (next === 0) {
      this.#overlayDepthByWindowId.delete(windowId);
      this.thaw(tabId);
    } else {
      this.#overlayDepthByWindowId.set(windowId, next);
    }
  }

  /** Re-announces a tab, or presents its native view when geometry is supplied. */
  present(
    tabId: string,
    windowId?: number,
    bounds?: Rectangle,
    animate = false,
    animationStartedAtEpochMs?: number,
  ): void {
    const record = this.#require(tabId);
    if (windowId === undefined || bounds === undefined) {
      this.#opened.publish({ ...record.descriptor, selection: "activate" });
      return;
    }
    const targetWindow = this.#windowById(windowId);
    if (!targetWindow || targetWindow.isDestroyed()) {
      throw new Error("The Penkra window is unavailable.");
    }
    const normalizedBounds = normalizeBounds(bounds);
    if (
      shouldKeepPresentationAnimation({
        animating: record.animationTimer !== null,
        ownerWindowId: record.ownerWindowId,
        requestedWindowId: windowId,
        currentBounds: record.bounds,
        requestedBounds: normalizedBounds,
      })
    ) {
      return;
    }
    if (record.ownerWindowId !== windowId) {
      this.#detach(record);
      targetWindow.contentView.addChildView(record.appView);
      record.ownerWindowId = windowId;
      this.#attachPage(record);
    }
    record.bounds = normalizedBounds;
    const contentBounds = targetWindow.getContentBounds();
    record.dockWidth = record.bounds.width;
    record.rightInset = Math.max(0, contentBounds.width - record.bounds.x - record.bounds.width);
    record.bottom = Math.max(0, contentBounds.height - record.bounds.y - record.bounds.height);
    record.visibleRequested = true;
    record.ownerWindowVisible = targetWindow.isVisible() && !targetWindow.isMinimized();
    const revealFromDock = record.hiddenByDock || animate;
    record.hiddenByDock = false;
    this.#stopAnimation(record);
    if (revealFromDock && record.freezeDepth === 0 && record.ownerWindowVisible) {
      const from = {
        ...record.bounds,
        x: targetWindow.getContentBounds().width,
      };
      this.#layoutApp(record, from);
      record.appView.setVisible(true);
      record.page?.view.setVisible(this.#shouldShowPage(record));
      this.#animateBounds(record, from, record.bounds, 300, animationStartedAtEpochMs);
    } else {
      this.#layoutApp(record);
      this.#layoutPage(record);
      record.appView.setVisible(shouldKeepNativeAppViewVisible(record));
    }
    this.#lastVisibleTabId = tabId;
    this.#sendEvent(record, "lifecycle.visibility", { active: true });
  }

  hide(tabId: string, animate = false, windowId?: number): void {
    const record = this.#require(tabId);
    if (windowId !== undefined && record.ownerWindowId !== windowId) {
      traceAppTabHost("low-level-hide-skipped", {
        tabId,
        windowId,
        ownerWindowId: record.ownerWindowId,
        reason: "owner-window-mismatch",
      });
      return;
    }
    traceAppTabHost("low-level-hide-started", {
      tabId,
      windowId: record.ownerWindowId,
      animate,
      freezeDepth: record.freezeDepth,
      visibleRequested: record.visibleRequested,
      appViewVisible: record.appView.getVisible(),
    });
    this.#stopAnimation(record);
    const window = record.ownerWindowId === null ? null : this.#windowById(record.ownerWindowId);
    if (
      animate &&
      window &&
      !window.isDestroyed() &&
      record.ownerWindowVisible &&
      record.freezeDepth === 0
    ) {
      record.hiddenByDock = true;
      this.#animateBounds(
        record,
        record.appView.getBounds(),
        { ...record.bounds, x: window.getContentBounds().width },
        300,
        undefined,
        () => {
          record.visibleRequested = false;
          record.appView.setVisible(false);
          record.page?.view.setVisible(false);
        },
      );
    } else {
      record.hiddenByDock = false;
      record.visibleRequested = false;
      record.appView.setVisible(false);
      record.page?.view.setVisible(false);
    }
    if (this.#lastVisibleTabId === tabId) this.#lastVisibleTabId = null;
    this.#sendEvent(record, "lifecycle.visibility", { active: false });
    if (window && !window.isDestroyed()) window.webContents.focus();
    traceAppTabHost("low-level-hide-completed", {
      tabId,
      windowId: record.ownerWindowId,
      animate,
      appViewVisible: record.appView.getVisible(),
      hostedPageVisible: record.page?.view.getVisible() ?? false,
    });
  }

  async captureReplica(tabId: string): Promise<AppTabReplicaFrame> {
    const record = this.#require(tabId);
    const [appFrame, pageFrame] = await Promise.all([
      record.appView.webContents.capturePage(),
      record.page && !record.page.view.webContents.isDestroyed()
        ? record.page.view.webContents.capturePage()
        : Promise.resolve(null),
    ]);
    record.lastFrame = appFrame;
    return {
      appFrameDataUrl: appFrame.toDataURL(),
      ...(pageFrame && !pageFrame.isEmpty() ? { pageFrameDataUrl: pageFrame.toDataURL() } : {}),
      pageTop: record.pageTop,
    };
  }

  setBounds(tabId: string, bounds: Rectangle): void {
    const record = this.#require(tabId);
    this.#stopAnimation(record);
    record.hiddenByDock = false;
    record.bounds = normalizeBounds(bounds);
    this.#layoutApp(record);
    this.#layoutPage(record);
  }

  async freeze(tabId: string): Promise<NativeImage> {
    const record = this.#require(tabId);
    record.freezeDepth += 1;
    if (record.freezeDepth > 1 && record.lastFrame) return record.lastFrame;
    // Native sibling views always composite above the shell renderer. Hide before the
    // asynchronous capture so a renderer-owned menu/dialog cannot be clipped for a frame.
    record.appView.setVisible(false);
    record.page?.view.setVisible(false);
    traceAppTabHost("freeze-hidden", {
      tabId,
      windowId: record.ownerWindowId,
      freezeDepth: record.freezeDepth,
      visibleRequested: record.visibleRequested,
    });
    const frame = await record.appView.webContents.capturePage();
    if (record.freezeDepth === 0) return frame;
    record.lastFrame = frame;
    return frame;
  }

  thaw(tabId: string): void {
    const record = this.#require(tabId);
    record.freezeDepth = Math.max(0, record.freezeDepth - 1);
    if (record.freezeDepth > 0) return;
    const visible = shouldKeepNativeAppViewVisible(record);
    record.appView.setVisible(visible);
    record.page?.view.setVisible(visible && this.#shouldShowPage(record));
    record.lastFrame = null;
    traceAppTabHost("thaw-visibility-applied", {
      tabId,
      windowId: record.ownerWindowId,
      freezeDepth: record.freezeDepth,
      visibleRequested: record.visibleRequested,
      visible,
      appViewVisible: record.appView.getVisible(),
      hostedPageVisible: record.page?.view.getVisible() ?? false,
    });
  }

  target(tabId: string, document: "d1" | "d2"): WebContents {
    const record = this.#require(tabId);
    if (document === "d2") {
      if (!record.page || record.page.view.webContents.isDestroyed()) {
        throw new Error(`App tab ${tabId} has no hosted document.`);
      }
      return record.page.view.webContents;
    }
    return record.appView.webContents;
  }

  bounds(tabId: string): Rectangle {
    return { ...this.#require(tabId).bounds };
  }

  pageBounds(tabId: string): Rectangle {
    const record = this.#require(tabId);
    return {
      x: record.bounds.x,
      y: record.bounds.y + record.pageTop,
      width: record.bounds.width,
      height: Math.max(1, record.bounds.height - record.pageTop),
    };
  }

  setHostedPageTop(tabId: string, height: number): void {
    const record = this.#require(tabId);
    if (!Number.isFinite(height) || height < 0) {
      throw new Error("Hosted-page toolbar height must be a non-negative finite number.");
    }
    const next = Math.round(height);
    if (record.pageTop === next) return;
    record.pageTop = next;
    this.#layoutApp(record);
    this.#layoutPage(record);
    this.#emitPresentation(record.descriptor.id);
  }

  hasHostedPage(tabId: string): boolean {
    return this.#records.get(tabId)?.page !== null;
  }

  hostedPageForWebContentsId(webContentsId: number): { tabId: string; pageId: string } | null {
    for (const record of this.#records.values()) {
      const pages = [...record.popupOpeners, ...(record.page ? [record.page] : [])];
      const page = pages.find((candidate) => candidate.view.webContents.id === webContentsId);
      if (page) return { tabId: record.descriptor.id, pageId: page.id };
    }
    return null;
  }

  hostedPageState(tabId: string): AppBrowserSessionState {
    const record = this.#require(tabId);
    const page = record.page;
    return {
      version: record.browserVersion,
      open: page !== null,
      page: page ? { ...page.state } : null,
      lastError: page?.state.lastError ?? null,
    };
  }

  async openHostedPage(tabId: string, initialUrl?: string): Promise<AppBrowserSessionState> {
    const record = this.#require(tabId);
    traceAppTabHost("browser-open-requested", {
      tabId,
      pageId: record.page?.id ?? null,
      hasInitialUrl: Boolean(initialUrl?.trim()),
    });
    if (!record.page) {
      await this.#browserExtensions.list(this.#browserPartition(record));
      record.page = this.#createHostedPage(record, normalizeBrowserUrlInput(initialUrl));
      this.#attachPage(record);
      this.#layoutApp(record);
      this.#layoutPage(record);
      await this.#loadHostedPage(record, record.page, record.page.state.url);
    } else if (initialUrl?.trim()) {
      await this.navigateHostedPage(tabId, record.page.id, initialUrl);
    }
    this.#emitBrowserState(record);
    return this.hostedPageState(tabId);
  }

  closeHostedPage(tabId: string): void {
    const record = this.#require(tabId);
    const pages = [...record.popupOpeners, ...(record.page ? [record.page] : [])];
    record.popupOpeners = [];
    record.page = null;
    for (const page of pages) this.#disposeHostedPage(record, page);
    record.browserVersion += 1;
    this.#layoutApp(record);
    this.#emitBrowserState(record);
  }

  async navigateHostedPage(
    tabId: string,
    pageId: string | undefined,
    url: string,
  ): Promise<AppBrowserSessionState> {
    const record = this.#require(tabId);
    if (!record.page) await this.openHostedPage(tabId);
    const page = this.#requireHostedPage(record, pageId);
    const nextUrl = normalizeBrowserUrlInput(url);
    traceAppTabHost("browser-navigate-requested", {
      tabId,
      pageId: page.id,
    });
    page.state = {
      ...page.state,
      url: nextUrl,
      title: defaultHostedPageTitle(nextUrl),
      lastCommittedUrl: null,
      lastError: null,
      faviconUrl: null,
    };
    record.browserVersion += 1;
    this.#emitBrowserState(record);
    await this.#loadHostedPage(record, page, nextUrl);
    return this.hostedPageState(tabId);
  }

  reloadHostedPage(tabId: string, pageId: string): AppBrowserSessionState {
    const page = this.#requireHostedPage(this.#require(tabId), pageId);
    traceAppTabHost("browser-reload-requested", {
      tabId,
      pageId,
    });
    page.view.webContents.reload();
    return this.hostedPageState(tabId);
  }

  stopHostedPage(tabId: string, pageId: string): AppBrowserSessionState {
    this.#requireHostedPage(this.#require(tabId), pageId).view.webContents.stop();
    return this.hostedPageState(tabId);
  }

  backHostedPage(tabId: string, pageId: string): AppBrowserSessionState {
    const contents = this.#requireHostedPage(this.#require(tabId), pageId).view.webContents;
    if (canHostedPageGoBack(contents)) contents.goBack();
    return this.hostedPageState(tabId);
  }

  forwardHostedPage(tabId: string, pageId: string): AppBrowserSessionState {
    const contents = this.#requireHostedPage(this.#require(tabId), pageId).view.webContents;
    if (canHostedPageGoForward(contents)) contents.goForward();
    return this.hostedPageState(tabId);
  }

  listHostedPageExtensionActions(tabId: string): Promise<ReadonlyArray<AppBrowserExtensionAction>> {
    const record = this.#require(tabId);
    return this.#browserExtensions.list(this.#browserPartition(record));
  }

  async openHostedPageExtensionAction(input: {
    tabId: string;
    pageId: string;
    extensionId: string;
  }): Promise<void> {
    const record = this.#require(input.tabId);
    const page = this.#requireHostedPage(record, input.pageId);
    const parent = record.ownerWindowId === null ? null : this.#windowById(record.ownerWindowId);
    await this.#browserExtensions.open({
      partition: this.#browserPartition(record),
      extensionId: input.extensionId,
      target: page.view.webContents,
      parent,
    });
  }

  async findInHostedPage(input: {
    tabId: string;
    pageId: string;
    text: string;
    action: "search" | "next" | "previous";
  }): Promise<{ activeMatchOrdinal: number; matches: number }> {
    const contents = this.#requireHostedPage(this.#require(input.tabId), input.pageId).view
      .webContents;
    return await new Promise((resolve) => {
      let requestId = -1;
      let settled = false;
      const finish = (result: { activeMatchOrdinal: number; matches: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        contents.removeListener("found-in-page", found);
        resolve(result);
      };
      const timeout = setTimeout(() => finish({ activeMatchOrdinal: 0, matches: 0 }), 2_000);
      const found = (_event: Electron.Event, result: Electron.FoundInPageResult) => {
        if (result.requestId === requestId && result.finalUpdate) {
          finish({
            activeMatchOrdinal: result.activeMatchOrdinal,
            matches: result.matches,
          });
        }
      };
      contents.on("found-in-page", found);
      requestId = contents.findInPage(input.text, {
        forward: input.action !== "previous",
        findNext: input.action !== "search",
        matchCase: false,
      });
    });
  }

  stopFindInHostedPage(tabId: string, pageId: string): void {
    this.#requireHostedPage(this.#require(tabId), pageId).view.webContents.stopFindInPage(
      "clearSelection",
    );
  }

  async captureHostedPage(
    tabId: string,
    pageId: string,
  ): Promise<{
    name: string;
    mimeType: "image/png";
    sizeBytes: number;
    bytes: Uint8Array;
  }> {
    const page = this.#requireHostedPage(this.#require(tabId), pageId);
    await page.pendingLoad;
    const bytes = page.view.webContents.capturePage().then((image) => image.toPNG());
    const png = await bytes;
    if (png.byteLength === 0) throw new Error("Couldn't capture the hosted page.");
    return {
      name: hostedPageScreenshotName(page.state.url),
      mimeType: "image/png",
      sizeBytes: png.byteLength,
      bytes: Uint8Array.from(png),
    };
  }

  async executeHostedPageCdp(input: {
    tabId: string;
    pageId: string;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown> {
    const page = this.#requireHostedPage(this.#require(input.tabId), input.pageId);
    await page.pendingLoad;
    const contents = page.view.webContents;
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    try {
      return await contents.debugger.sendCommand(input.method, input.params ?? {});
    } catch (error) {
      throw new Error(
        `CDP ${input.method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async prepareHostedPageObservation(tabId: string, pageId: string): Promise<boolean> {
    const record = this.#records.get(tabId);
    if (!record?.page || record.page.id !== pageId) return false;
    await record.page.pendingLoad;
    return !record.page.view.webContents.isDestroyed();
  }

  ownerWindowId(tabId: string): number | null {
    return this.#require(tabId).ownerWindowId;
  }

  isVisible(tabId: string): boolean {
    const record = this.#require(tabId);
    return record.visibleRequested && record.ownerWindowVisible && record.freezeDepth === 0;
  }

  tabForWindow(windowId: number): DesktopAppTabDescriptor | null {
    const owned = [...this.#records.values()]
      .reverse()
      .filter((record) => record.ownerWindowId === windowId);
    return (owned.find((record) => record.visibleRequested) ?? owned[0])?.descriptor ?? null;
  }

  resizeWindow(windowId: number, width: number, height: number): void {
    for (const record of this.#records.values()) {
      if (record.ownerWindowId !== windowId) continue;
      const next = resizedAppTabBounds({
        bounds: record.bounds,
        dockWidth: record.dockWidth,
        rightInset: record.rightInset,
        bottom: record.bottom,
        width,
        height,
      });
      this.setBounds(record.descriptor.id, next);
      const presentation = this.#presentationsByTabId.get(record.descriptor.id)?.get(windowId);
      if (presentation) presentation.bounds = next;
    }
  }

  hideWindow(windowId: number): void {
    for (const record of this.#records.values()) {
      if (record.ownerWindowId !== windowId) continue;
      record.ownerWindowVisible = false;
      const visible = shouldKeepNativeAppViewVisible(record);
      record.appView.setVisible(visible);
      record.page?.view.setVisible(visible && this.#shouldShowPage(record));
      traceAppTabHost("window-hide-applied", {
        tabId: record.descriptor.id,
        windowId,
        visibleRequested: record.visibleRequested,
        freezeDepth: record.freezeDepth,
        appViewVisible: record.appView.getVisible(),
        hostedPageVisible: record.page?.view.getVisible() ?? false,
      });
    }
  }

  showWindow(windowId: number): void {
    for (const record of this.#records.values()) {
      if (record.ownerWindowId !== windowId) continue;
      record.ownerWindowVisible = true;
      const visible = shouldKeepNativeAppViewVisible(record);
      record.appView.setVisible(visible);
      record.page?.view.setVisible(visible && this.#shouldShowPage(record));
      traceAppTabHost("window-show-applied", {
        tabId: record.descriptor.id,
        windowId,
        visibleRequested: record.visibleRequested,
        freezeDepth: record.freezeDepth,
        appViewVisible: record.appView.getVisible(),
        hostedPageVisible: record.page?.view.getVisible() ?? false,
      });
    }
  }

  releaseWindow(windowId: number): void {
    for (const record of this.#records.values()) {
      if (record.ownerWindowId === windowId) this.#detach(record);
    }
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

  setZoomFactor(zoomFactor: number, windowId?: number): void {
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
      throw new Error("Invalid App tab zoom factor.");
    }
    for (const record of this.#records.values()) {
      if (windowId !== undefined && record.ownerWindowId !== windowId) continue;
      if (!record.appView.webContents.isDestroyed()) {
        record.appView.webContents.setZoomFactor(zoomFactor);
      }
      if (record.page && !record.page.view.webContents.isDestroyed()) {
        record.page.view.webContents.setZoomFactor(zoomFactor);
      }
    }
  }

  rendererId(tabId: string): number {
    return this.#require(tabId).rendererId;
  }

  async navigate(tabId: string, input: { route: string; state?: unknown }): Promise<void> {
    await this.#navigate(tabId, input);
  }

  setRoute(tabId: string, input: { route: string; state?: unknown }): void {
    const record = this.#require(tabId);
    record.navigation = {
      route: input.route,
      ...(input.state === undefined ? {} : { state: input.state }),
    };
    record.descriptor = {
      ...record.descriptor,
      route: input.route,
      ...(input.state === undefined ? { state: undefined } : { state: input.state }),
    };
    this.#state.publish(record.descriptor);
    this.#diagnostics.publish({
      kind: "tab-navigation-recorded",
      appId: record.app.appId,
      spaceId: record.descriptor.spaceId,
      tabId,
      message: input.route,
    });
  }

  setPresentation(
    tabId: string,
    input: { title?: string; icon?: "hosted-page" | { dataUrl: string } },
  ): void {
    const record = this.#require(tabId);
    record.presentationIconSource = input.icon ?? null;
    record.descriptor = {
      ...record.descriptor,
      presentationTitle: input.title ?? null,
      presentationIconUrl:
        record.presentationIconSource === "hosted-page"
          ? (record.page?.state.faviconUrl ?? null)
          : (record.presentationIconSource?.dataUrl ?? null),
    };
    this.#state.publish(record.descriptor);
  }

  resetPresentation(tabId: string): void {
    this.setPresentation(tabId, {});
  }

  setContext(tabId: string, input: { deckId: string; threadId: string }): void {
    const record = this.#require(tabId);
    if (record.descriptor.deckId !== input.deckId) {
      throw new Error("An App tab cannot move between Thread Decks.");
    }
    if (record.descriptor.threadId === input.threadId) return;

    record.releaseIdentity();
    const releaseRendererIdentity = this.#registerRendererIdentity({
      appId: record.app.appId,
      spaceId: record.descriptor.spaceId,
      deckId: record.descriptor.deckId,
      threadId: input.threadId,
      tabId,
      rendererId: record.rendererId,
    });
    let identityReleased = false;
    record.releaseIdentity = () => {
      if (identityReleased) return;
      identityReleased = true;
      releaseRendererIdentity?.();
    };
    record.endpoint.threadId = input.threadId;
    record.descriptor = { ...record.descriptor, threadId: input.threadId };
    this.#state.publish(record.descriptor);
    this.#sendEvent(record, "thread.context-changed", {
      deckId: record.descriptor.deckId,
      threadId: input.threadId,
    });
  }

  sendEvent(tabId: string, name: string, payload: unknown): void {
    this.#sendEvent(this.#require(tabId), name, payload);
  }

  captureForUpdate(appId: string, spaceId: string): ReadonlyArray<AppUpdateTabSnapshot> {
    return [...this.#records.values()]
      .filter((record) => record.app.appId === appId && record.descriptor.spaceId === spaceId)
      .map((record) => ({
        id: record.descriptor.id,
        deckId: record.descriptor.deckId,
        threadId: record.descriptor.threadId,
        ...record.navigation,
      }));
  }

  async restoreAfterUpdate(
    appId: string,
    spaceId: string,
    tabs: ReadonlyArray<AppUpdateTabSnapshot>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      tabs.map((tab) =>
        this.#openInstalled(
          {
            tabId: tab.id,
            appId,
            spaceId,
            deckId: tab.deckId,
            threadId: tab.threadId,
            route: tab.route,
            ...(tab.state === undefined ? {} : { state: tab.state }),
          },
          true,
        ),
      ),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.status !== "rejected") continue;
      const tab = tabs[index];
      if (!tab) continue;
      let retirementFailure: unknown;
      try {
        this.#authority.retireTab({
          appId,
          spaceId,
          deckId: tab.deckId,
          threadId: tab.threadId,
          tabId: tab.id,
        });
      } catch (error) {
        retirementFailure = error;
      }
      this.#closed.publish({
        id: tab.id,
        deckId: tab.deckId,
        threadId: tab.threadId,
      });
      const failure = appRuntimeOperationFailure({
        message: "App tab restoration failed.",
        primary: result.reason,
        ...(retirementFailure === undefined
          ? {}
          : {
              secondary: [{ role: "tab-retirement", failure: retirementFailure }],
            }),
      });
      this.#diagnostics.publish({
        kind: "tab-navigation-restore-failed",
        appId,
        spaceId,
        tabId: tab.id,
        message: safeErrorMessage(result.reason),
        failure: appRuntimeFailureDto(failure),
      });
    }
  }

  close(tabId: string, reason: OperationCancellationCode = "tab-closed"): void {
    const record = this.#records.get(tabId);
    if (!record) return;
    traceAppTabHost("tab-close-started", {
      tabId,
      reason,
      rendererId: record.rendererId,
      ownerWindowId: record.ownerWindowId,
    });
    if (this.#lastVisibleTabId === tabId) this.#lastVisibleTabId = null;
    this.#records.delete(tabId);
    this.#detach(record);
    const hostedPages = [...record.popupOpeners, ...(record.page ? [record.page] : [])];
    record.popupOpeners = [];
    record.page = null;
    for (const page of hostedPages) this.#disposeHostedPage(record, page);
    this.#presentationsByTabId.delete(tabId);
    this.#replicaFrameByTabId.delete(tabId);
    const failures: Array<{ role: string; failure: unknown }> = [];
    this.#attemptRetirement(failures, "generation-authority", () =>
      this.#authority.retireGeneration(this.#generationOwner(record)),
    );
    this.#attemptRetirement(failures, "operation-broker", record.unregisterBroker);
    this.#attemptRetirement(failures, "renderer-rpc", () => record.unregisterRpc(reason));
    this.#attemptRetirement(failures, "renderer-identity", record.releaseIdentity);
    this.#attemptRetirement(failures, "app-view", () => {
      if (!record.appView.webContents.isDestroyed()) record.appView.webContents.close();
    });
    if (shouldRetireLogicalAppTab(reason)) {
      this.#attemptRetirement(failures, "tab-authority", () =>
        this.#authority.retireTab(this.#tabOwner(record)),
      );
    }
    if (shouldNotifyAppTabClosed(reason)) {
      this.#closed.publish({
        id: tabId,
        deckId: record.descriptor.deckId,
        threadId: record.descriptor.threadId,
      });
    }
    if (failures.length > 0) {
      const failure = appRuntimeGroupFailure("App tab retirement was incomplete.", failures);
      this.#diagnostics.publish({
        kind: "operation-failed",
        appId: record.app.appId,
        spaceId: record.descriptor.spaceId,
        tabId,
        operation: "tab-retirement",
        message: failure.message,
        failure: appRuntimeFailureDto(failure),
      });
    }
  }

  closeAll(reason: OperationCancellationCode = "host-stopped"): void {
    for (const tabId of [...this.#records.keys()]) this.close(tabId, reason);
    this.#browserExtensions.closeAllPopups();
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

  async #create(input: OpenAppTabRequest & { tabId?: string }): Promise<AppTabHandle> {
    const rollback = new RollbackScope();
    const openedAt = performance.now();
    await this.#assertAppAllowed(input.app);
    const activeSession = this.#sessions.get(input.app.appId, input.spaceId);
    if (!activeSession) {
      throw new Error(`${input.app.name} is not active in this Space.`);
    }
    const id = input.tabId ?? randomUUID();
    if (this.#records.has(id)) throw new Error(`App tab ${id} is already open.`);
    const appView = new WebContentsView({
      webPreferences: createAppRendererPreferences({
        appId: input.app.appId,
        spaceId: input.spaceId,
        preloadPath: this.#preloadPath,
      }),
    });
    appView.setBackgroundColor("#00000000");
    appView.setBorderRadius(0);
    const contents = appView.webContents;
    const rendererId = contents.id;
    const documentUrl = createAppDocumentUrlForOrigin(
      activeSession.origin,
      input.app.manifest.entrypoints.tab,
    );
    try {
      const releaseRendererIdentity = this.#registerRendererIdentity({
        appId: input.app.appId,
        spaceId: input.spaceId,
        deckId: input.deckId,
        threadId: input.threadId,
        tabId: id,
        rendererId,
      });
      let identityReleased = false;
      const releaseIdentity = () => {
        if (identityReleased) return;
        identityReleased = true;
        releaseRendererIdentity?.();
      };
      rollback.defer("renderer-identity", releaseIdentity);
      rollback.defer("app-view", () => {
        if (!contents.isDestroyed()) contents.close();
      });
      const descriptor: DesktopAppTabDescriptor = {
        id,
        rendererId,
        appId: input.app.appId,
        slug: input.app.slug,
        name: input.app.name,
        agentAddressable: input.app.manifest.agentAddressable !== false,
        iconDataUrl: await this.#resolveIconDataUrl(input.app),
        spaceId: input.spaceId,
        deckId: input.deckId,
        threadId: input.threadId,
        route: input.route,
        ...(input.state === undefined ? {} : { state: input.state }),
        status: "loading",
      };
      const target = {
        id: rendererId,
        send: (message: AppRendererRpcHostMessage) =>
          contents.send(APP_RUNTIME_IPC_CHANNELS.hostMessage, message),
      };
      const unregisterRpc = this.#rpc.registerTarget(target);
      rollback.defer("renderer-rpc", () => unregisterRpc("host-stopped"));
      const endpoint: AppTabEndpoint = {
        id,
        appId: input.app.appId,
        spaceId: input.spaceId,
        deckId: input.deckId,
        threadId: input.threadId,
        close: async () => this.close(id),
        navigate: (navigation) => this.#navigate(id, navigation),
        navigateForResult: (navigation) => this.#request(id, "tab.navigate-for-result", navigation),
        invoke: (request) => this.#request(id, "tab.invoke", request),
      };
      const unregisterBroker = this.#broker.registerTab(endpoint);
      rollback.defer("operation-broker", unregisterBroker);
      const record: AppTabRecord = {
        presentationIconSource: null,
        descriptor,
        endpoint,
        app: input.app,
        rendererId,
        appView,
        page: null,
        popupOpeners: [],
        ownerWindowId: null,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        dockWidth: 0,
        rightInset: 0,
        bottom: 0,
        pageTop: 0,
        browserVersion: 0,
        lastFrame: null,
        freezeDepth: 0,
        visibleRequested: false,
        ownerWindowVisible: false,
        hiddenByDock: false,
        animationTimer: null,
        unregisterBroker,
        unregisterRpc,
        releaseIdentity,
        navigation: {
          route: input.route,
          ...(input.state === undefined ? {} : { state: input.state }),
        },
        openedAt,
        themeCssKey: null,
        typographyCssKey: null,
      };
      this.#records.set(id, record);
      traceAppTabHost("app-renderer-created", {
        tabId: id,
        rendererId,
        appId: input.app.appId,
        spaceId: input.spaceId,
        deckId: input.deckId,
        threadId: input.threadId,
      });
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("before-input-event", (event, keyboardInput) =>
        this.#onBeforeInput(event, keyboardInput),
      );
      contents.on("will-navigate", (event) => {
        traceAppTabHost("app-renderer-will-navigate", {
          tabId: id,
          rendererId,
        });
        if (decideAppSpaceNavigation(activeSession.origin, event.url).action === "deny") {
          event.preventDefault();
        }
      });
      contents.on("did-start-loading", () =>
        traceAppTabHost("app-renderer-load-started", { tabId: id, rendererId }),
      );
      contents.on("did-stop-loading", () =>
        traceAppTabHost("app-renderer-load-stopped", {
          tabId: id,
          rendererId,
        }),
      );
      contents.on("did-navigate", () =>
        traceAppTabHost("app-renderer-navigated", {
          tabId: id,
          rendererId,
        }),
      );
      contents.on("preload-error", (_event, preloadPath, error) => {
        console.error(
          `[penkra-app] App preload failed for ${input.app.appId} in Space ${input.spaceId} at ${preloadPath}: ${error.message}`,
        );
      });
      contents.on("render-process-gone", (_event, details) => {
        if (!this.#records.has(id)) return;
        record.descriptor = { ...record.descriptor, status: "crashed" };
        this.#state.publish(record.descriptor);
        this.#diagnostics.publish({
          kind: "tab-crashed",
          appId: input.app.appId,
          spaceId: input.spaceId,
          tabId: id,
          message: `${details.reason} (exit ${details.exitCode})`,
        });
      });
      contents.once("destroyed", () => {
        traceAppTabHost("app-renderer-destroyed", { tabId: id, rendererId });
        if (this.#records.has(id)) this.close(id, "host-stopped");
      });
      rollback.commit();
      // A supplied ID restores an existing logical tab; recreating its renderer
      // must not replace the user's selection, even in another Thread.
      this.#opened.publish({
        ...record.descriptor,
        selection: input.tabId === undefined ? "activate" : "preserve",
      });
      this.#diagnostics.publish({
        kind: "tab-opened",
        appId: input.app.appId,
        spaceId: input.spaceId,
        tabId: id,
      });
      const ready = this.#ipcBridge.waitForReady(rendererId);
      traceAppTabHost("app-renderer-initial-load-requested", {
        tabId: id,
        rendererId,
      });
      await Promise.all([contents.loadURL(documentUrl), ready]);
      traceAppTabHost("app-renderer-ready", {
        tabId: id,
        rendererId,
        durationMs: Math.round(performance.now() - openedAt),
      });
      record.descriptor = { ...record.descriptor, status: "ready" };
      if (this.#themeCss) await this.#applyCss(record, "themeCssKey", this.#themeCss);
      if (this.#typographyCss) {
        await this.#applyCss(record, "typographyCssKey", this.#typographyCss);
      }
      this.#state.publish(record.descriptor);
      this.#diagnostics.publish({
        kind: "tab-ready",
        appId: input.app.appId,
        spaceId: input.spaceId,
        tabId: id,
        durationMs: Math.round(performance.now() - openedAt),
      });
      return endpoint;
    } catch (error) {
      traceAppTabHost("app-renderer-create-failed", {
        tabId: id,
        rendererId,
        error: safeErrorMessage(error),
      });
      if (this.#records.has(id)) this.close(id, "host-stopped");
      return rollback.fail(`App tab ${id} could not be created.`, error);
    }
  }

  #closeMatchingRenderer(tabId: string, rendererId: number): void {
    if (!this.#matchingRenderer(tabId, rendererId)) return;
    this.close(tabId, "tab-closed");
  }

  #attemptRetirement(
    failures: Array<{ role: string; failure: unknown }>,
    role: string,
    operation: () => void,
  ): void {
    try {
      operation();
    } catch (failure) {
      failures.push({ role, failure });
    }
  }

  #generationOwner(record: AppTabRecord): AppTabGenerationOwner {
    return {
      ...this.#tabOwner(record),
      rendererId: record.rendererId,
    };
  }

  #tabOwner(record: AppTabRecord): AppTabLogicalOwner {
    return {
      appId: record.app.appId,
      spaceId: record.descriptor.spaceId,
      deckId: record.descriptor.deckId,
      threadId: record.descriptor.threadId,
      tabId: record.descriptor.id,
    };
  }

  #request<Result>(
    tabId: string,
    method: "tab.invoke" | "tab.navigate" | "tab.navigate-for-result",
    input: unknown,
  ): Promise<Result> {
    return this.#rpc.request<Result>(this.#require(tabId).appView.webContents.id, method, input);
  }

  async #navigate(tabId: string, input: { route: string; state?: unknown }): Promise<void> {
    const record = this.#require(tabId);
    await this.#rpc.request(record.rendererId, "tab.navigate", input, {
      targetLabel: record.app.name,
    });
    this.setRoute(tabId, input);
  }

  #require(tabId: string): AppTabRecord {
    const record = this.#records.get(tabId);
    if (!record) throw new Error(`App tab ${tabId} is unavailable.`);
    return record;
  }

  #matchingRenderer(tabId: string, rendererId: number): AppTabRecord | null {
    const record = this.#records.get(tabId);
    return record?.appView.webContents.id === rendererId ? record : null;
  }

  async #applyCss(
    record: AppTabRecord,
    keyName: "themeCssKey" | "typographyCssKey",
    css: string,
  ): Promise<void> {
    const nextKey = await record.appView.webContents.insertCSS(css, {
      cssOrigin: "author",
    });
    const previousKey = record[keyName];
    record[keyName] = nextKey;
    if (previousKey) await record.appView.webContents.removeInsertedCSS(previousKey);
  }

  #createHostedPage(
    record: AppTabRecord,
    url: string,
    chromiumWebContents?: WebContents,
  ): HostedPage {
    const partition = this.#browserPartition(record);
    this.#browserSessionPolicy.ensureConfigured(partition);
    const view = chromiumWebContents
      ? new WebContentsView({ webContents: chromiumWebContents })
      : new WebContentsView({
          webPreferences: {
            partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
    view.setBorderRadius(0);
    view.setVisible(false);
    const pageId = record.page?.id ?? randomUUID();
    const page: HostedPage = {
      id: pageId,
      view,
      state: {
        id: pageId,
        url,
        title: defaultHostedPageTitle(url),
        presentation: "host",
        status: "live",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        lastCommittedUrl: null,
        lastError: null,
      },
      disposers: [],
      pendingLoad: null,
      isPopup: chromiumWebContents !== undefined,
    };
    this.#configureHostedPage(record, page);
    return page;
  }

  #browserPartition(record: AppTabRecord): string {
    return createScopedBrowserSessionPartition(record.descriptor.appId, record.descriptor.spaceId);
  }

  #configureHostedPage(record: AppTabRecord, page: HostedPage): void {
    const contents = page.view.webContents;
    this.#browserSessionPolicy.applyUserAgent(contents, page.state.url);
    const beforeInput = (event: Electron.Event, input: Electron.Input) =>
      this.#onBeforeInput(event, input);
    const didStartLoading = () => {
      traceAppTabHost("hosted-page-load-started", {
        tabId: record.descriptor.id,
        pageId: page.id,
        rendererId: contents.id,
      });
      if (!contents.isLoadingMainFrame() || page.state.isLoading) return;
      page.state = { ...page.state, isLoading: true, lastError: null };
      this.#hostedPageChanged(record);
    };
    const didStartNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      traceAppTabHost("hosted-page-frame-navigation-started", {
        tabId: record.descriptor.id,
        pageId: page.id,
        rendererId: contents.id,
        isMainFrame: details.isMainFrame,
        isSameDocument: details.isSameDocument,
        frameProcessId: details.frame?.processId ?? null,
        frameRoutingId: details.frame?.routingId ?? null,
        urlOrigin: new URL(details.url).origin,
      });
      if (details.isMainFrame && !details.isSameDocument) {
        page.state = {
          ...page.state,
          title: defaultHostedPageTitle(details.url),
          faviconUrl: null,
        };
        this.#hostedPageChanged(record);
      }
    };
    const didFrameFinishLoad = (
      _event: Electron.Event,
      isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      traceAppTabHost("hosted-page-frame-load-finished", {
        tabId: record.descriptor.id,
        pageId: page.id,
        rendererId: contents.id,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      });
      if (isMainFrame) this.#syncHostedPage(record, page);
    };
    const didStopLoading = () => {
      traceAppTabHost("hosted-page-load-stopped", {
        tabId: record.descriptor.id,
        pageId: page.id,
        rendererId: contents.id,
      });
      if (page.state.isLoading) this.#syncHostedPage(record, page);
    };
    const didNavigate = () => {
      traceAppTabHost("hosted-page-navigated", {
        tabId: record.descriptor.id,
        pageId: page.id,
        rendererId: contents.id,
      });
      this.#syncHostedPage(record, page);
    };
    const didNavigateInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean) => {
      traceAppTabHost("hosted-page-navigated-in-page", {
        tabId: record.descriptor.id,
        pageId: page.id,
        rendererId: contents.id,
        isMainFrame,
      });
      if (isMainFrame) this.#syncHostedPage(record, page);
    };
    const pageTitleUpdated = (event: Electron.Event, title: string) => {
      event.preventDefault();
      page.state = {
        ...page.state,
        title: title || defaultHostedPageTitle(page.state.url),
      };
      this.#hostedPageChanged(record);
    };
    const pageFaviconUpdated = (_event: Electron.Event, urls: string[]) => {
      page.state = {
        ...page.state,
        faviconUrl: urls[0] ?? page.state.faviconUrl,
      };
      this.#hostedPageChanged(record);
    };
    const didFailLoad = (
      _event: Electron.Event,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || code === -3) return;
      traceAppTabHost("hosted-page-load-failed", {
        tabId: record.descriptor.id,
        pageId: page.id,
        rendererId: contents.id,
        code,
        description,
      });
      page.state = {
        ...page.state,
        url: validatedUrl || page.state.url,
        isLoading: false,
        lastError: hostedPageLoadError(code, description),
      };
      this.#hostedPageChanged(record);
    };
    contents.on("before-input-event", beforeInput);
    contents.on("did-start-loading", didStartLoading);
    contents.on("did-start-navigation", didStartNavigation);
    contents.on("did-frame-finish-load", didFrameFinishLoad);
    contents.on("did-stop-loading", didStopLoading);
    contents.on("did-navigate", didNavigate);
    contents.on("did-navigate-in-page", didNavigateInPage);
    contents.on("page-title-updated", pageTitleUpdated);
    contents.on("page-favicon-updated", pageFaviconUpdated);
    contents.on("did-fail-load", didFailLoad);
    page.disposers.push(
      () => contents.removeListener("before-input-event", beforeInput),
      () => contents.removeListener("did-start-loading", didStartLoading),
      () => contents.removeListener("did-start-navigation", didStartNavigation),
      () => contents.removeListener("did-frame-finish-load", didFrameFinishLoad),
      () => contents.removeListener("did-stop-loading", didStopLoading),
      () => contents.removeListener("did-navigate", didNavigate),
      () => contents.removeListener("did-navigate-in-page", didNavigateInPage),
      () => contents.removeListener("page-title-updated", pageTitleUpdated),
      () => contents.removeListener("page-favicon-updated", pageFaviconUpdated),
      () => contents.removeListener("did-fail-load", didFailLoad),
    );
    contents.setWindowOpenHandler((details) => {
      const isWeb = details.url === BROWSER_BLANK_URL || /^https?:\/\//i.test(details.url.trim());
      if (!isWeb) return { action: "deny" };
      const kind = classifyBrowserWindowOpen(details);
      if (kind === "tab" && details.postBody === undefined) {
        void this.openSibling(record.descriptor.id, {
          route: "/",
          state: { url: details.url },
        });
        return { action: "deny" };
      }
      return {
        action: "allow",
        outlivesOpener: true,
        createWindow: (options: BrowserWindowConstructorOptions) => {
          const popupContents = (
            options as BrowserWindowConstructorOptions & {
              webContents?: WebContents;
            }
          ).webContents;
          if (!popupContents) throw new Error("Chromium did not provide popup WebContents.");
          return this.#adoptHostedPopup(record, page, details.url, popupContents).view.webContents;
        },
      };
    });
  }

  #adoptHostedPopup(
    record: AppTabRecord,
    opener: HostedPage,
    url: string,
    contents: WebContents,
  ): HostedPage {
    const popup = this.#createHostedPage(record, url, contents);
    popup.id = opener.id;
    popup.state = { ...popup.state, id: opener.id };
    const window = record.ownerWindowId === null ? null : this.#windowById(record.ownerWindowId);
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(opener.view);
      } catch {
        // The opener may already be detached during a window transition.
      }
    }
    opener.view.setVisible(false);
    record.popupOpeners.push(opener);
    record.page = popup;
    this.#attachPage(record);
    this.#layoutPage(record);
    const restore = () => {
      if (record.page !== popup) return;
      const restored = record.popupOpeners.pop() ?? null;
      record.page = restored;
      this.#disposeHostedPage(record, popup, false);
      this.#attachPage(record);
      this.#layoutApp(record);
      this.#layoutPage(record);
      this.#hostedPageChanged(record);
    };
    contents.once("destroyed", restore);
    popup.disposers.push(() => contents.removeListener("destroyed", restore));
    return popup;
  }

  #attachPage(record: AppTabRecord): void {
    if (!record.page || record.ownerWindowId === null) return;
    const window = this.#windowById(record.ownerWindowId);
    if (!window || window.isDestroyed()) return;
    try {
      window.contentView.removeChildView(record.page.view);
    } catch {
      // A newly created view is not attached yet.
    }
    window.contentView.addChildView(record.page.view);
    window.contentView.addChildView(record.appView);
  }

  #disposeHostedPage(record: AppTabRecord, page: HostedPage, close = true): void {
    this.#browserExtensions.closePopupForTarget(
      this.#browserPartition(record),
      page.view.webContents.id,
    );
    const window = record.ownerWindowId === null ? null : this.#windowById(record.ownerWindowId);
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(page.view);
      } catch {
        // Already detached.
      }
    }
    for (const dispose of page.disposers.splice(0)) dispose();
    if (close && !page.view.webContents.isDestroyed()) {
      if (page.view.webContents.debugger.isAttached()) {
        try {
          page.view.webContents.debugger.detach();
        } catch {
          // Closing the WebContents is authoritative cleanup.
        }
      }
      page.view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  async #loadHostedPage(record: AppTabRecord, page: HostedPage, url: string): Promise<void> {
    traceAppTabHost("hosted-page-load-queued", {
      tabId: record.descriptor.id,
      pageId: page.id,
      rendererId: page.view.webContents.id,
      hadPendingLoad: page.pendingLoad !== null,
    });
    const previous = page.pendingLoad ?? Promise.resolve();
    const load = previous
      .catch(() => undefined)
      .then(async () => {
        if (record.page !== page || page.view.webContents.isDestroyed()) {
          traceAppTabHost("hosted-page-load-skipped", {
            tabId: record.descriptor.id,
            pageId: page.id,
            reason: record.page !== page ? "page-replaced" : "renderer-destroyed",
          });
          return;
        }
        traceAppTabHost("hosted-page-load-requested", {
          tabId: record.descriptor.id,
          pageId: page.id,
          rendererId: page.view.webContents.id,
        });
        this.#browserSessionPolicy.applyUserAgent(page.view.webContents, url);
        try {
          await page.view.webContents.loadURL(url);
          traceAppTabHost("hosted-page-load-resolved", {
            tabId: record.descriptor.id,
            pageId: page.id,
            rendererId: page.view.webContents.id,
          });
        } catch (error) {
          if (error instanceof Error && /ERR_ABORTED|\(-3\)/i.test(error.message)) {
            traceAppTabHost("hosted-page-load-aborted", {
              tabId: record.descriptor.id,
              pageId: page.id,
            });
            return;
          }
          traceAppTabHost("hosted-page-load-rejected", {
            tabId: record.descriptor.id,
            pageId: page.id,
            error: safeErrorMessage(error),
          });
          page.state = {
            ...page.state,
            isLoading: false,
            lastError: error instanceof Error ? error.message : "Couldn't open this page.",
          };
          this.#hostedPageChanged(record);
        }
      });
    const pendingLoad = load.finally(() => {
      if (page.pendingLoad === pendingLoad) page.pendingLoad = null;
    });
    page.pendingLoad = pendingLoad;
    await page.pendingLoad;
  }

  #syncHostedPage(record: AppTabRecord, page: HostedPage): void {
    if (page.view.webContents.isDestroyed()) return;
    const contents = page.view.webContents;
    const liveUrl = contents.getURL();
    const committed = liveUrl.startsWith("chrome-error://") ? "" : liveUrl;
    const url = committed || page.state.url;
    page.state = {
      ...page.state,
      url,
      title: contents.getTitle() || defaultHostedPageTitle(url),
      status: "live",
      isLoading: contents.isLoadingMainFrame(),
      canGoBack: canHostedPageGoBack(contents),
      canGoForward: canHostedPageGoForward(contents),
      lastCommittedUrl: committed || page.state.lastCommittedUrl,
      ...(committed ? { lastError: null } : {}),
    };
    this.#hostedPageChanged(record);
  }

  #hostedPageChanged(record: AppTabRecord): void {
    record.browserVersion += 1;
    if (record.presentationIconSource === "hosted-page") {
      const iconUrl = record.page?.state.faviconUrl ?? null;
      if (record.descriptor.presentationIconUrl !== iconUrl) {
        record.descriptor = { ...record.descriptor, presentationIconUrl: iconUrl };
        this.#state.publish(record.descriptor);
      }
    }
    this.#layoutApp(record);
    this.#layoutPage(record);
    this.#emitBrowserState(record);
  }

  #emitBrowserState(record: AppTabRecord): void {
    this.#sendEvent(record, "browser.state", this.hostedPageState(record.descriptor.id));
  }

  #requireHostedPage(record: AppTabRecord, pageId?: string): HostedPage {
    const page = record.page;
    if (!page || (pageId !== undefined && page.id !== pageId)) {
      throw new Error("The hosted page is unavailable.");
    }
    return page;
  }

  #latestVisiblePresentation(
    tabId: string,
    excludingWindowId?: number,
  ): [number, AppTabWindowPresentation] | null {
    return (
      [...(this.#presentationsByTabId.get(tabId)?.entries() ?? [])]
        .filter(
          ([windowId, value]) =>
            windowId !== excludingWindowId &&
            value.visible &&
            value.windowVisible &&
            this.#windowById(windowId) !== null,
        )
        .sort((left, right) => right[1].selectedAt - left[1].selectedAt)[0] ?? null
    );
  }

  #emitPresentation(tabId: string): void {
    const record = this.#records.get(tabId);
    if (!record) return;
    const frame = this.#replicaFrameByTabId.get(tabId);
    const presentations = this.#presentationsByTabId.get(tabId);
    for (const [windowId, presentation] of presentations ?? []) {
      let state: DesktopAppTabPresentation;
      const mode = resolveAppTabPresentationMode({
        ownsWindow: record.ownerWindowId === windowId,
        presentationVisible: presentation.visible,
        windowVisible: presentation.windowVisible,
        hasReplica: frame !== undefined,
      });
      if (mode === "live") {
        state = { tabId, mode: "live", ownerWindowId: windowId };
      } else if (mode === "replica" && frame) {
        state = {
          tabId,
          mode: "replica",
          ownerWindowId: record.ownerWindowId,
          ...frame,
        };
      } else {
        state = { tabId, mode: "hidden", ownerWindowId: record.ownerWindowId };
      }
      this.#onPresentation(windowId, state);
    }
  }

  #shouldShowPage(record: AppTabRecord): boolean {
    return (
      !!record.page &&
      record.pageTop > 0 &&
      record.page.state.url !== BROWSER_BLANK_URL &&
      record.page.state.lastError === null
    );
  }

  #detach(record: AppTabRecord): void {
    this.#stopAnimation(record);
    if (record.ownerWindowId === null) return;
    const window = this.#windowById(record.ownerWindowId);
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(record.appView);
        if (record.page) window.contentView.removeChildView(record.page.view);
      } catch {
        // Already detached while the window was closing.
      }
    }
    record.ownerWindowId = null;
    record.ownerWindowVisible = false;
  }

  #layoutPage(record: AppTabRecord): void {
    if (!record.page) return;
    this.#layoutPageAt(record, record.bounds);
  }

  #layoutPageAt(record: AppTabRecord, sourceBounds: Rectangle): void {
    if (!record.page) return;
    const bounds = {
      x: sourceBounds.x,
      y: sourceBounds.y + record.pageTop,
      width: sourceBounds.width,
      height: Math.max(0, sourceBounds.height - record.pageTop),
    };
    const currentBounds = record.page.view.getBounds();
    const currentVisible = record.page.view.getVisible();
    const visible =
      record.visibleRequested && record.freezeDepth === 0 && this.#shouldShowPage(record);
    if (
      currentVisible !== visible ||
      currentBounds.x !== bounds.x ||
      currentBounds.y !== bounds.y ||
      currentBounds.width !== bounds.width ||
      currentBounds.height !== bounds.height
    ) {
      traceAppTabHost("hosted-page-view-layout-change", {
        tabId: record.descriptor.id,
        pageId: record.page.id,
        rendererId: record.page.view.webContents.id,
        currentBounds,
        bounds,
        currentVisible,
        visible,
        visibleRequested: record.visibleRequested,
        freezeDepth: record.freezeDepth,
        ownerWindowVisible: record.ownerWindowVisible,
        pageHasError: record.page.state.lastError !== null,
      });
    }
    record.page.view.setBounds(bounds);
    record.page.view.setVisible(visible);
  }

  #layoutApp(record: AppTabRecord, sourceBounds: Rectangle = record.bounds): void {
    const bounds = {
      ...sourceBounds,
      height:
        record.page && record.pageTop > 0 && record.page.state.url !== BROWSER_BLANK_URL
          ? Math.min(sourceBounds.height, record.pageTop)
          : sourceBounds.height,
    };
    record.appView.setBounds(bounds);
  }

  #stopAnimation(record: AppTabRecord): void {
    if (record.animationTimer !== null) clearTimeout(record.animationTimer);
    record.animationTimer = null;
  }

  #animateBounds(
    record: AppTabRecord,
    from: Rectangle,
    to: Rectangle,
    durationMs: number,
    animationStartedAtEpochMs?: number,
    complete?: () => void,
  ): void {
    const elapsedBeforeReceipt =
      animationStartedAtEpochMs === undefined
        ? 0
        : Math.max(0, Math.min(durationMs, Date.now() - animationStartedAtEpochMs));
    const startedAt = performance.now() - elapsedBeforeReceipt;
    const tick = () => {
      const now = performance.now();
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = dockTransitionProgress(progress);
      this.#layoutApp(record, {
        x: Math.round(from.x + (to.x - from.x) * eased),
        y: Math.round(from.y + (to.y - from.y) * eased),
        width: Math.round(from.width + (to.width - from.width) * eased),
        height: Math.round(from.height + (to.height - from.height) * eased),
      });
      this.#layoutPageAt(record, {
        x: Math.round(from.x + (to.x - from.x) * eased),
        y: Math.round(from.y + (to.y - from.y) * eased),
        width: Math.round(from.width + (to.width - from.width) * eased),
        height: Math.round(from.height + (to.height - from.height) * eased),
      });
      if (progress < 1) {
        record.animationTimer = setTimeout(tick, 16);
        return;
      }
      record.animationTimer = null;
      complete?.();
    };
    tick();
  }

  #sendEvent(record: AppTabRecord, name: string, payload: unknown): void {
    if (!record.appView.webContents.isDestroyed()) {
      record.appView.webContents.send(APP_RUNTIME_IPC_CHANNELS.event, {
        name,
        payload,
      });
    }
  }
}

function normalizeBounds(bounds: Rectangle): Rectangle {
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

function rectanglesEqual(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Matches the shell's `cubic-bezier(0.32, 0.72, 0, 1)` dock transition. */
export function dockTransitionProgress(progress: number): number {
  const target = Math.max(0, Math.min(1, progress));
  if (target === 0 || target === 1) return target;
  let lower = 0;
  let upper = 1;
  let parameter = target;
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const x = cubicBezierCoordinate(parameter, 0.32, 0);
    if (x < target) lower = parameter;
    else upper = parameter;
    parameter = (lower + upper) / 2;
  }
  return cubicBezierCoordinate(parameter, 0.72, 1);
}

function cubicBezierCoordinate(parameter: number, first: number, second: number): number {
  const inverse = 1 - parameter;
  return (
    3 * inverse * inverse * parameter * first +
    3 * inverse * parameter * parameter * second +
    parameter * parameter * parameter
  );
}

function safeErrorMessage(value: unknown): string {
  try {
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return String(value);
  } catch {
    return "[unprintable thrown value]";
  }
}

function defaultHostedPageTitle(url: string): string {
  if (url === BROWSER_BLANK_URL) return "New page";
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function hostedPageLoadError(code: number, description: string): string {
  switch (code) {
    case -102:
      return "Connection refused.";
    case -105:
      return "Couldn't resolve this address.";
    case -106:
      return "You're offline.";
    case -118:
      return "This page took too long to respond.";
    case -137:
    case -200:
      return "A secure connection couldn't be established.";
    default:
      return description || "Couldn't open this page.";
  }
}

function hostedPageScreenshotName(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `${host || "browser"}-${Date.now()}.png`;
  } catch {
    return `browser-${Date.now()}.png`;
  }
}

function canHostedPageGoBack(contents: WebContents): boolean {
  return contents.navigationHistory?.canGoBack() ?? contents.canGoBack();
}

function canHostedPageGoForward(contents: WebContents): boolean {
  return contents.navigationHistory?.canGoForward() ?? contents.canGoForward();
}

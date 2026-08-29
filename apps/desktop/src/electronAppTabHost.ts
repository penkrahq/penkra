// FILE: electronAppTabHost.ts
// Purpose: Owns isolated App-tab renderers and attaches them to the trusted right panel.
// Layer: Trusted desktop App runtime

import { randomUUID } from "node:crypto";

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
import type { AppSessionManager } from "./appSessionManager";
import type { AppFrameDocumentRegistry } from "./appFrameDocumentRegistry";
import type { AppRuntimeDiagnosticInput } from "./appRuntimeDiagnostics";
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
  threadId: string;
  tabId: string;
  rendererId: number;
}

export interface AppTabLogicalOwner {
  appId: string;
  spaceId: string;
  threadId: string;
  tabId: string;
}

export interface AppTabAuthority {
  /** Synchronously detaches authority belonging to one exact iframe execution generation. */
  retireGeneration(owner: AppTabGenerationOwner): void;
  /** Retires resources owned by the stable logical tab after it is actually closed. */
  retireTab(owner: AppTabLogicalOwner): void;
}

interface AppTabRecord {
  descriptor: DesktopAppTabDescriptor;
  app: InstalledAppPackage;
  rendererId: number;
  unregisterBroker: () => void;
  unregisterRpc: (reason?: OperationCancellationCode) => void;
  releaseIdentity: () => void;
  navigation: { route: string; state?: unknown };
  frameReady: boolean;
  queuedHostMessages: AppRendererRpcHostMessage[];
  queuedEvents: Array<{ name: string; payload: unknown }>;
  openedAt: number;
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
  threadId: string;
  route: string;
  state?: unknown;
}

export class ElectronAppTabHost implements AppTabHost {
  readonly #installations: AppInstallationService;
  readonly #sessions: Pick<AppSessionManager, "get">;
  readonly #frameDocuments: Pick<AppFrameDocumentRegistry, "activate">;
  readonly #broker: Pick<AppOperationBroker, "registerTab">;
  readonly #rpc: Pick<
    AppRendererRpcHost,
    "registerTarget" | "request" | "acceptResponse" | "acceptContextCall"
  >;
  readonly #ipcBridge: Pick<AppRendererIpcBridge, "waitForReady">;
  readonly #opened: ProtectedPublisher<DesktopAppTabDescriptor>;
  readonly #state: ProtectedPublisher<DesktopAppTabDescriptor>;
  readonly #onFrameHostMessage: (input: {
    tabId: string;
    rendererId: number;
    delivery:
      | { kind: "host-message"; message: AppRendererRpcHostMessage }
      | { kind: "event"; name: string; payload: unknown };
  }) => void;
  readonly #closed: ProtectedPublisher<DesktopAppTabClosed>;
  readonly #registerRendererIdentity: (input: {
    appId: string;
    spaceId: string;
    threadId: string;
    tabId: string;
    rendererId: number;
  }) => (() => void) | void;
  readonly #authority: AppTabAuthority;
  readonly #assertAppAllowed: (app: InstalledAppPackage) => Promise<void>;
  readonly #resolveIconDataUrl: typeof resolveInstalledAppIconDataUrl;
  readonly #diagnostics: ProtectedPublisher<AppRuntimeDiagnosticInput>;
  readonly #records = new Map<string, AppTabRecord>();
  #themeCss = "";
  #typographyCss = "";
  #visibleTabId: string | null = null;
  #nextRendererId = -1;

  constructor(input: {
    installations: AppInstallationService;
    sessions: Pick<AppSessionManager, "get">;
    frameDocuments: Pick<AppFrameDocumentRegistry, "activate">;
    broker: Pick<AppOperationBroker, "registerTab">;
    rpc: Pick<
      AppRendererRpcHost,
      "registerTarget" | "request" | "acceptResponse" | "acceptContextCall"
    >;
    ipcBridge: Pick<AppRendererIpcBridge, "waitForReady">;
    onOpened: (descriptor: DesktopAppTabDescriptor) => void;
    onState: (descriptor: DesktopAppTabDescriptor) => void;
    onFrameHostMessage?: (input: {
      tabId: string;
      rendererId: number;
      delivery:
        | { kind: "host-message"; message: AppRendererRpcHostMessage }
        | { kind: "event"; name: string; payload: unknown };
    }) => void;
    onClosed?: (descriptor: DesktopAppTabClosed) => void;
    registerRendererIdentity?: (input: {
      appId: string;
      spaceId: string;
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
    this.#frameDocuments = input.frameDocuments;
    this.#broker = input.broker;
    this.#rpc = input.rpc;
    this.#ipcBridge = input.ipcBridge;
    const onNotificationError =
      input.onNotificationError ??
      ((error: unknown) => console.error("[penkra-app] App tab notification failed.", error));
    this.#opened = new ProtectedPublisher(onNotificationError);
    this.#opened.subscribe(input.onOpened);
    this.#state = new ProtectedPublisher(onNotificationError);
    this.#state.subscribe(input.onState);
    this.#onFrameHostMessage = input.onFrameHostMessage ?? (() => undefined);
    this.#closed = new ProtectedPublisher(onNotificationError);
    this.#closed.subscribe(input.onClosed ?? (() => undefined));
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

  has(tabId: string): boolean {
    return this.#records.has(tabId);
  }

  listFor(spaceId: string, threadId: string): ReadonlyArray<DesktopAppTabDescriptor> {
    return this.list().filter(
      (descriptor) => descriptor.spaceId === spaceId && descriptor.threadId === threadId,
    );
  }

  current(): DesktopAppTabDescriptor | null {
    return this.#visibleTabId === null
      ? null
      : (this.#records.get(this.#visibleTabId)?.descriptor ?? null);
  }

  currentFor(spaceId: string, threadId: string): DesktopAppTabDescriptor | null {
    const current = this.current();
    return current?.spaceId === spaceId && current.threadId === threadId ? current : null;
  }

  /** Re-announces an existing tab so the trusted shell opens its dock and selects it. */
  present(tabId: string): void {
    this.#opened.publish(this.#require(tabId).descriptor);
  }

  async applyTheme(css: string): Promise<void> {
    this.#themeCss = css;
    for (const record of this.#records.values())
      this.#sendEvent(record, "appearance.theme-css", css);
  }

  async applyTypography(css: string): Promise<void> {
    this.#typographyCss = css;
    for (const record of this.#records.values()) {
      this.#sendEvent(record, "appearance.typography-css", css);
    }
  }

  setZoomFactor(zoomFactor: number): void {
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
      throw new Error("Invalid App tab zoom factor.");
    }
    for (const record of this.#records.values())
      this.#sendEvent(record, "appearance.zoom", zoomFactor);
  }

  rendererId(tabId: string): number {
    return this.#require(tabId).rendererId;
  }

  setActive(tabId: string, rendererId: number, active: boolean): boolean {
    const record = this.#matchingRenderer(tabId, rendererId);
    if (!record) return false;
    if (active) {
      this.#visibleTabId = tabId;
    } else {
      if (this.#visibleTabId === tabId) this.#visibleTabId = null;
    }
    this.#sendEvent(record, "lifecycle.visibility", { active });
    this.#diagnostics.publish({
      kind: active ? "tab-activated" : "tab-deactivated",
      appId: record.app.appId,
      spaceId: record.descriptor.spaceId,
      tabId,
    });
    return true;
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

  acceptFrameMessage(tabId: string, rendererId: number, message: unknown): void {
    if (!this.#matchingRenderer(tabId, rendererId)) throw new Error("The App frame is stale.");
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("The App frame message is invalid.");
    }
    const type = (message as { type?: unknown }).type;
    if (type === "result" || type === "error") this.#rpc.acceptResponse(rendererId, message);
    else if (type === "context-call") this.#rpc.acceptContextCall(rendererId, message);
    else throw new Error("The App frame message type is invalid.");
  }

  frameIdentity(
    tabId: string,
    rendererId: number,
  ): {
    appId: string;
    spaceId: string;
    threadId: string;
    tabId: string;
  } {
    const record = this.#matchingRenderer(tabId, rendererId);
    if (!record) throw new Error("The App frame is stale.");
    return {
      appId: record.app.appId,
      spaceId: record.descriptor.spaceId,
      threadId: record.descriptor.threadId,
      tabId,
    };
  }

  markFrameReady(tabId: string, rendererId: number): void {
    const record = this.#matchingRenderer(tabId, rendererId);
    if (!record) throw new Error("The App frame is stale.");
    if (record.frameReady) {
      const startedAt = performance.now();
      void this.#request(tabId, "tab.navigate", record.navigation).then(
        () =>
          this.#diagnostics.publish({
            kind: "tab-navigation-restored",
            appId: record.app.appId,
            spaceId: record.descriptor.spaceId,
            tabId,
            durationMs: Math.round(performance.now() - startedAt),
            message: record.navigation.route,
          }),
        (error: unknown) =>
          this.#diagnostics.publish({
            kind: "tab-navigation-restore-failed",
            appId: record.app.appId,
            spaceId: record.descriptor.spaceId,
            tabId,
            durationMs: Math.round(performance.now() - startedAt),
            message: error instanceof Error ? error.message : String(error),
          }),
      );
      if (this.#themeCss) this.#sendEvent(record, "appearance.theme-css", this.#themeCss);
      if (this.#typographyCss) {
        this.#sendEvent(record, "appearance.typography-css", this.#typographyCss);
      }
      this.#sendEvent(record, "lifecycle.visibility", { active: this.#visibleTabId === tabId });
      return;
    }
    record.frameReady = true;
    record.descriptor = { ...record.descriptor, status: "ready" };
    this.#state.publish(record.descriptor);
    this.#diagnostics.publish({
      kind: "tab-ready",
      appId: record.app.appId,
      spaceId: record.descriptor.spaceId,
      tabId,
      durationMs: Math.round(performance.now() - record.openedAt),
    });
    for (const message of record.queuedHostMessages.splice(0)) {
      this.#onFrameHostMessage({
        tabId,
        rendererId,
        delivery: { kind: "host-message", message },
      });
    }
    for (const event of record.queuedEvents.splice(0))
      this.#sendEvent(record, event.name, event.payload);
    if (this.#themeCss) this.#sendEvent(record, "appearance.theme-css", this.#themeCss);
    if (this.#typographyCss) {
      this.#sendEvent(record, "appearance.typography-css", this.#typographyCss);
    }
  }

  sendFrameEvent(tabId: string, name: string, payload: unknown): void {
    this.#sendEvent(this.#require(tabId), name, payload);
  }

  captureForUpdate(appId: string, spaceId: string): ReadonlyArray<AppUpdateTabSnapshot> {
    return [...this.#records.values()]
      .filter((record) => record.app.appId === appId && record.descriptor.spaceId === spaceId)
      .map((record) => ({
        id: record.descriptor.id,
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
        this.#authority.retireTab({ appId, spaceId, threadId: tab.threadId, tabId: tab.id });
      } catch (error) {
        retirementFailure = error;
      }
      this.#closed.publish({ id: tab.id, threadId: tab.threadId });
      const failure = appRuntimeOperationFailure({
        message: "App tab restoration failed.",
        primary: result.reason,
        ...(retirementFailure === undefined
          ? {}
          : { secondary: [{ role: "tab-retirement", failure: retirementFailure }] }),
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
    if (this.#visibleTabId === tabId) this.#visibleTabId = null;
    this.#records.delete(tabId);
    const failures: Array<{ role: string; failure: unknown }> = [];
    this.#attemptRetirement(failures, "generation-authority", () =>
      this.#authority.retireGeneration(this.#generationOwner(record)),
    );
    this.#attemptRetirement(failures, "operation-broker", record.unregisterBroker);
    this.#attemptRetirement(failures, "renderer-rpc", () => record.unregisterRpc(reason));
    this.#attemptRetirement(failures, "renderer-identity", record.releaseIdentity);
    if (shouldRetireLogicalAppTab(reason)) {
      this.#attemptRetirement(failures, "tab-authority", () =>
        this.#authority.retireTab(this.#tabOwner(record)),
      );
    }
    if (shouldNotifyAppTabClosed(reason)) {
      this.#closed.publish({ id: tabId, threadId: record.descriptor.threadId });
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
    if (!this.#sessions.get(input.app.appId, input.spaceId)) {
      throw new Error(`${input.app.name} is not active in this Space.`);
    }
    const id = input.tabId ?? randomUUID();
    if (this.#records.has(id)) throw new Error(`App tab ${id} is already open.`);
    // A Runtime v2 visual tab is a DOM iframe in the trusted shell. This negative token is a
    // host-minted capability identity, not an Electron WebContents id; no hidden native renderer
    // or second compositor surface exists for a visual App.
    const rendererId = this.#nextRendererId--;
    const documentBase = await this.#frameDocuments.activate(input.app, input.spaceId);
    const documentUrl = `${documentBase}${documentBase.includes("?") ? "&" : "?"}penkra-renderer=${encodeURIComponent(rendererId)}#penkra-tab=${encodeURIComponent(id)}`;
    try {
      const releaseRendererIdentity = this.#registerRendererIdentity({
        appId: input.app.appId,
        spaceId: input.spaceId,
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
      const descriptor: DesktopAppTabDescriptor = {
        id,
        rendererId,
        appId: input.app.appId,
        slug: input.app.slug,
        name: input.app.name,
        iconDataUrl: await this.#resolveIconDataUrl(input.app),
        spaceId: input.spaceId,
        threadId: input.threadId,
        route: input.route,
        ...(input.state === undefined ? {} : { state: input.state }),
        status: "loading",
        documentUrl,
      };
      const target = {
        id: rendererId,
        send: (message: AppRendererRpcHostMessage) => {
          const current = this.#records.get(id);
          if (!current?.frameReady) {
            current?.queuedHostMessages.push(message);
            return;
          }
          this.#onFrameHostMessage({
            tabId: id,
            rendererId,
            delivery: { kind: "host-message", message },
          });
        },
      };
      const unregisterRpc = this.#rpc.registerTarget(target);
      rollback.defer("renderer-rpc", () => unregisterRpc("host-stopped"));
      const endpoint: AppTabEndpoint = {
        id,
        appId: input.app.appId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        close: async () => this.close(id),
        navigate: (navigation) => this.#navigate(id, navigation),
        navigateForResult: (navigation) => this.#request(id, "tab.navigate-for-result", navigation),
        invoke: (request) => this.#request(id, "tab.invoke", request),
      };
      const unregisterBroker = this.#broker.registerTab(endpoint);
      rollback.defer("operation-broker", unregisterBroker);
      const record: AppTabRecord = {
        descriptor,
        app: input.app,
        rendererId,
        unregisterBroker,
        unregisterRpc,
        releaseIdentity,
        navigation: {
          route: input.route,
          ...(input.state === undefined ? {} : { state: input.state }),
        },
        frameReady: false,
        queuedHostMessages: [],
        queuedEvents: [],
        openedAt,
      };
      this.#records.set(id, record);
      rollback.commit();
      this.#opened.publish(record.descriptor);
      this.#diagnostics.publish({
        kind: "tab-opened",
        appId: input.app.appId,
        spaceId: input.spaceId,
        tabId: id,
      });
      return endpoint;
    } catch (error) {
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
      threadId: record.descriptor.threadId,
      tabId: record.descriptor.id,
    };
  }

  #request<Result>(
    tabId: string,
    method: "tab.invoke" | "tab.navigate" | "tab.navigate-for-result",
    input: unknown,
  ): Promise<Result> {
    return this.#rpc.request<Result>(this.#require(tabId).rendererId, method, input);
  }

  async #navigate(tabId: string, input: { route: string; state?: unknown }): Promise<void> {
    await this.#request(tabId, "tab.navigate", input);
    this.setRoute(tabId, input);
  }

  #require(tabId: string): AppTabRecord {
    const record = this.#records.get(tabId);
    if (!record) throw new Error(`App tab ${tabId} is unavailable.`);
    return record;
  }

  #matchingRenderer(tabId: string, rendererId: number): AppTabRecord | null {
    const record = this.#records.get(tabId);
    return record?.rendererId === rendererId ? record : null;
  }

  #sendEvent(record: AppTabRecord, name: string, payload: unknown): void {
    if (!record.frameReady) {
      record.queuedEvents.push({ name, payload });
      return;
    }
    this.#onFrameHostMessage({
      tabId: record.descriptor.id,
      rendererId: record.rendererId,
      delivery: { kind: "event", name, payload },
    });
  }
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

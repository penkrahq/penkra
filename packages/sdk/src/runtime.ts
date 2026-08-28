import type { OperationContext } from "./operations";
import type { PenkraPermissionName } from "./permissions";
import type {
  AppSimulatorButton,
  AppSimulatorCreateDeviceInput,
  AppSimulatorDeviceType,
  AppSimulatorEnvironment,
  AppSimulatorRuntime,
  AppSimulatorSetupRequest,
  AppSimulatorSavedDevice,
  AppSimulatorSessionState,
  AppSimulatorSwipeInput,
  AppSimulatorTarget,
} from "./simulator";

export interface AppPermissionStatus {
  name: PenkraPermissionName;
  declared: boolean;
  required: boolean;
  state: "denied" | "granted";
}

export interface AppIdentity {
  /** Installation-stable pairwise subject. Null while the user is signed out. */
  subject: string | null;
  /** Stable opaque identity for the current Space, scoped to this App. */
  space: string;
}

export interface AppIdentityToken {
  token: string;
  expiresAt: string;
}

export interface AppAccountDataResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface AppAccountRealtimeEvent {
  channel: string;
  event: string;
  payload: unknown;
  occurredAt: string;
}

export type AppAccountRealtimeConnectionState = "connected" | "reconnecting";

export interface AppAccountRealtimeSubscriptionOptions {
  onConnectionStateChange?(state: AppAccountRealtimeConnectionState): void;
}

export interface AppContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  /** Starts a new visual group before this actionable row. */
  separatorBefore?: boolean;
  destructive?: boolean;
}

export interface AppScopedFileHandle {
  id: string;
  kind: "file" | "directory";
  name: string;
}

export interface AppScopedFileEntry {
  kind: "file" | "directory";
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export interface AppScopedBinaryRead {
  bytes: Uint8Array;
  totalBytes: number;
  complete: boolean;
}

export interface AppScopedFileWrite {
  writeId: string;
  chunkBytes: number;
}

export interface AppTransferProgressEvent {
  id: string;
  phase: "uploading" | "downloading";
  movedBytes: number;
  totalBytes: number | null;
}

export interface AppBrowserPage {
  id: string;
  url: string;
  title: string;
  status: "live" | "suspended";
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastCommittedUrl: string | null;
  lastError: string | null;
}

export interface AppBrowserExtensionAction {
  id: string;
  name: string;
  iconDataUrl: string;
}

export interface AppBrowserSessionState {
  version: number;
  open: boolean;
  activePageId: string | null;
  pages: ReadonlyArray<AppBrowserPage>;
  extensionActions: ReadonlyArray<AppBrowserExtensionAction>;
  lastError: string | null;
}

export interface AppBrowserDownloadEvent {
  pageId: string;
  url: string;
  suggestedName: string;
  mimeType: string;
  state: "pending" | "completed" | "failed";
  /**
   * Absolute host path in this App and Space's private storage root.
   * A visual tab may pass this value to its Node operation controller, which can open it with
   * ordinary Node filesystem APIs. The App owns correlation, retention, and cleanup.
   */
  path: string;
  /** Storage-relative key for the same file, suitable for `storage.open` or `storage.remove`. */
  storagePath: string;
  bytes: number;
  error?: string;
}

export interface AppBrowserFindResult {
  activeMatchOrdinal: number;
  matches: number;
}

/** Stable App-local edges for a host-owned surface that fills the remaining viewport. */
export interface AppHostedSurfaceInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type AppOperationHandler<Input = unknown, Result = unknown> = (
  input: Input,
  context: OperationContext,
) => Promise<Result> | Result;

export interface AppTabHandlerContext {
  signal: AbortSignal;
}

export type AppTabOperationHandler<Input = unknown, Result = unknown> = (
  input: Input,
  context: AppTabHandlerContext,
) => Promise<Result> | Result;

export interface AppTabNavigationInput {
  route: string;
  state?: unknown;
}

export interface AppTabVisibility {
  /** True while this tab is the visible right-panel App surface. */
  active: boolean;
}

export interface AppStorageFileEntry {
  /** Absolute host path inside this App's private storage root. */
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface AppComposerModelSelection {
  provider: string;
  model: string;
  options?: Readonly<Record<string, unknown>>;
}

export interface AppComposerStageInput {
  text?: string;
  documents?: Array<{ title: string; content: string }>;
  files?: Array<{ name?: string; mimeType?: string; path: string }>;
  images?: Array<{ name?: string; mimeType?: string; path: string }>;
  skills?: string[];
  model?: ReadonlyArray<AppComposerModelSelection>;
  effort?: string;
}

export type AppTabNavigationHandler<Result = void> = (
  input: AppTabNavigationInput,
  context: AppTabHandlerContext,
) => Promise<Result> | Result;

export interface PenkraTabRuntimeApi {
  readonly runtime: { readonly kind: "tab" };
  /** Visual-tab only. Show a native context menu at the current pointer position. */
  contextMenu: {
    show<T extends string>(items: ReadonlyArray<AppContextMenuItem<T>>): Promise<T | null>;
  };
  /** Visual-tab only. User-selected or host-handed-off files scoped to this App and Space. */
  files: {
    list(): Promise<ReadonlyArray<AppScopedFileHandle>>;
    pick(
      kind: "file" | "directory" | "save",
      options?: { suggestedName?: string },
    ): Promise<AppScopedFileHandle | null>;
    open(handleId: string, relativePath?: string): Promise<string>;
    closeUrl(url: string): Promise<void>;
    revoke(handleId: string): Promise<void>;
    stat(handleId: string, relativePath?: string): Promise<AppScopedFileEntry>;
    listDirectory(
      handleId: string,
      relativePath?: string,
    ): Promise<ReadonlyArray<AppScopedFileEntry>>;
    readText(handleId: string, relativePath?: string): Promise<string>;
    readBinary(input: {
      handleId: string;
      relativePath?: string;
      offset?: number;
      length?: number;
    }): Promise<AppScopedBinaryRead>;
    beginWrite(input: {
      handleId: string;
      relativePath?: string;
      expectedBytes: number;
      expectedSha256?: string;
    }): Promise<AppScopedFileWrite>;
    writeChunk(input: { writeId: string; offset: number; bytes: Uint8Array }): Promise<{
      writtenBytes: number;
    }>;
    commitWrite(writeId: string): Promise<void>;
    abortWrite(writeId: string): Promise<void>;
    writeText(handleId: string, source: string, relativePath?: string): Promise<void>;
    createDirectory(handleId: string, relativePath: string): Promise<AppScopedFileEntry>;
    watch(
      handleId: string,
      relativePath: string | undefined,
      listener: () => void,
    ): Promise<() => void>;
  };
  /** Visual-tab only. Host-mediated private storage scoped to this App and Space. */
  storage: {
    open(path: string): Promise<string>;
    closeUrl(url: string): Promise<void>;
    writeFile(input: {
      into: string;
      content: string;
      encoding?: "utf-8" | "base64";
    }): Promise<{ path: string; bytes: number }>;
    remove(input: { path: string; recursive?: boolean }): Promise<void>;
    list(input?: { path?: string }): Promise<ReadonlyArray<AppStorageFileEntry>>;
    usage(): Promise<{ bytes: number }>;
  };
  /** Visual-tab only. Host-validated bulk transfer for handles and App-storage bytes. */
  transfer: {
    begin(input: {
      url: string;
      method?: "POST" | "PUT" | "PATCH";
      headers?: Record<string, string>;
    }): Promise<{ id: string; endpoint: string }>;
    send(input: {
      url: string;
      method?: "POST" | "PUT" | "PATCH";
      headers?: Record<string, string>;
      from: { handleId: string; relativePath?: string } | { storage: string };
      field?: string;
    }): Promise<{
      id: string;
      status: number;
      headers: Record<string, string>;
      body: string;
    }>;
    /**
     * Download directly to App storage or an opaque picked-file handle. The result intentionally
     * has no path: picked handles do not disclose host paths. Use the known storage key when the
     * destination is App storage.
     */
    receive(input: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      to: { storage: string } | { handleId: string; relativePath?: string };
    }): Promise<{ id: string; bytes: number; sha256: string }>;
    onProgress(listener: (event: AppTransferProgressEvent) => void): () => void;
  };
  /** Visual-tab only. */
  composer: {
    /** Stage a visible draft in this App surface's thread. Never sends it. */
    stage(input: AppComposerStageInput): Promise<{
      resolvedModel: AppComposerModelSelection | null;
    }>;
  };
  /** Visual-tab only. Open one scoped file with a trusted host handler. */
  open(input: { handleId: string; relativePath?: string; with: "system" }): Promise<void>;
  /** Visual-tab only. The App owns browser chrome; Penkra owns page isolation. */
  browser: {
    open(initialUrl?: string): Promise<AppBrowserSessionState>;
    close(): Promise<void>;
    getState(): Promise<AppBrowserSessionState>;
    onState(listener: (state: AppBrowserSessionState) => void): () => void;
    onDownload(listener: (event: AppBrowserDownloadEvent) => void): () => void;
    setSurfaceLayout(insets: AppHostedSurfaceInsets | null): Promise<void>;
    navigate(input: { pageId?: string; url: string }): Promise<AppBrowserSessionState>;
    reload(pageId: string): Promise<AppBrowserSessionState>;
    stop(pageId: string): Promise<AppBrowserSessionState>;
    back(pageId: string): Promise<AppBrowserSessionState>;
    forward(pageId: string): Promise<AppBrowserSessionState>;
    newPage(input?: { url?: string; activate?: boolean }): Promise<AppBrowserSessionState>;
    closePage(pageId: string): Promise<AppBrowserSessionState>;
    selectPage(pageId: string): Promise<AppBrowserSessionState>;
    openExtensionAction(input: { extensionId: string; pageId: string }): Promise<void>;
    find(input: {
      pageId: string;
      text: string;
      action?: "search" | "next" | "previous";
    }): Promise<AppBrowserFindResult>;
    stopFind(pageId: string): Promise<void>;
    capture(pageId: string): Promise<{ dataUrl: string }>;
    evaluate(input: { pageId: string; expression: string }): Promise<unknown>;
  };
  /** Visual-tab only. The App owns simulator chrome; Penkra owns native lifecycle. */
  simulator: {
    getEnvironment(): Promise<AppSimulatorEnvironment>;
    listRuntimes(): Promise<ReadonlyArray<AppSimulatorRuntime>>;
    listDeviceTypes(runtimeId?: string): Promise<ReadonlyArray<AppSimulatorDeviceType>>;
    listDevices(): Promise<ReadonlyArray<AppSimulatorSavedDevice>>;
    createDevice(input: AppSimulatorCreateDeviceInput): Promise<AppSimulatorSavedDevice>;
    eraseDevice(deviceId: string): Promise<AppSimulatorSavedDevice>;
    deleteDevice(deviceId: string): Promise<void>;
    requestSetup(input: AppSimulatorSetupRequest): Promise<AppSimulatorEnvironment>;
    cancelSetup(): Promise<void>;
    open(deviceId: string): Promise<AppSimulatorSessionState>;
    close(): Promise<void>;
    getState(): Promise<AppSimulatorSessionState>;
    onState(listener: (state: AppSimulatorSessionState) => void): () => void;
    setViewport(
      bounds: { x: number; y: number; width: number; height: number } | null,
    ): Promise<void>;
    getTarget(): Promise<AppSimulatorTarget>;
    capture(): Promise<{ dataUrl: string }>;
    tap(point: { x: number; y: number }): Promise<void>;
    swipe(input: AppSimulatorSwipeInput): Promise<void>;
    type(text: string): Promise<void>;
    press(button: AppSimulatorButton): Promise<void>;
    rotate(orientation: "portrait" | "landscape"): Promise<AppSimulatorSessionState>;
  };
  identity: {
    get(): Promise<AppIdentity>;
    /** Mint a short-lived token for this App's manifest-declared backend audience. */
    getToken(input: { audience: string }): Promise<AppIdentityToken>;
  };
  /** Credential-hidden access to this App's Account-scoped backend namespace. */
  account: {
    request(input: {
      path: string;
      method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
      body?: string | Uint8Array;
      contentType?: "application/json" | "application/octet-stream";
    }): Promise<AppAccountDataResponse>;
    /** Visual-tab only realtime subscription. Controllers may use request(). */
    subscribe(
      channel: string,
      listener: (event: AppAccountRealtimeEvent) => void,
      options?: AppAccountRealtimeSubscriptionOptions,
    ): Promise<() => void>;
  };
  settings: {
    get(key: string): Promise<boolean | number | string>;
    set(key: string, value: boolean | number | string): Promise<void>;
    reset(key: string): Promise<void>;
  };
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  /** Visual-tab only mediated HTTP. Controllers use ordinary Node HTTP APIs. */
  network: {
    fetch(input: {
      url: string;
      method?: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT";
      headers?: Readonly<Record<string, string>>;
      body?: string | Uint8Array;
      timeoutMs?: number;
    }): Promise<{
      url: string;
      status: number;
      headers: Readonly<Record<string, string>>;
      body: Uint8Array;
    }>;
  };
  permissions: {
    /** Inspect this App's grant in its current Space without prompting. */
    query(name: PenkraPermissionName): Promise<AppPermissionStatus>;
    /** Visual-tab only. Request a permission in direct response to a user-invoked feature. */
    request(name: PenkraPermissionName): Promise<AppPermissionStatus>;
  };
  /** Visual-tab only. Operation controllers receive tab handles through OperationContext. */
  tab: {
    /**
     * Identity of this App-owned surface. `threadId` is the containing Penkra Thread; `tabId` is
     * this App tab and is distinct from both the Thread and any hosted Browser page ID.
     */
    getContext(): Promise<{ threadId: string; tabId: string | null }>;
    /** Record the App's current route so the host can restore it after reloads and updates. */
    setRoute(input: AppTabNavigationInput): Promise<void>;
    /** Pause expensive visual work while the tab is retained but not visible. */
    onVisibilityChange(listener: (visibility: AppTabVisibility) => void): () => void;
    handle<Input = unknown, Result = unknown>(
      operation: string,
      handler: AppTabOperationHandler<Input, Result>,
    ): () => void;
    onNavigate<Result = void>(handler: AppTabNavigationHandler<Result>): () => void;
  };
}

/**
 * Penkra-owned services available to an App's non-visual Node operation controller.
 * Ordinary filesystem, HTTP, crypto, Buffer, and stream work uses standard Node APIs instead.
 */
export type PenkraControllerRuntimeApi = Pick<
  PenkraTabRuntimeApi,
  "identity" | "secrets" | "settings"
> & {
  readonly runtime: { readonly kind: "controller" };
  operations: {
    handle<Input = unknown, Result = unknown>(
      handlerKey: string,
      handler: AppOperationHandler<Input, Result>,
    ): () => void;
  };
  account: Pick<PenkraTabRuntimeApi["account"], "request">;
  permissions: Pick<PenkraTabRuntimeApi["permissions"], "query">;
};

function runtime(): PenkraTabRuntimeApi {
  const candidate = (globalThis as { penkra?: PenkraTabRuntimeApi }).penkra;
  if (!candidate) {
    throw new Error("Penkra App runtime is unavailable. Run this package inside Penkra.");
  }
  if (candidate.runtime?.kind !== "tab") {
    throw new Error(
      "@penkra/sdk/tab is available only in a visual App tab. Import @penkra/sdk/controller from an operation controller.",
    );
  }
  return candidate;
}

export const contextMenu: PenkraTabRuntimeApi["contextMenu"] = {
  show: (items) => runtime().contextMenu.show(items),
};

export const files: PenkraTabRuntimeApi["files"] = {
  list: () => runtime().files.list(),
  pick: (kind, options) => runtime().files.pick(kind, options),
  open: (handleId, relativePath) => runtime().files.open(handleId, relativePath),
  closeUrl: (url) => runtime().files.closeUrl(url),
  revoke: (handleId) => runtime().files.revoke(handleId),
  stat: (handleId, relativePath) => runtime().files.stat(handleId, relativePath),
  listDirectory: (handleId, relativePath) => runtime().files.listDirectory(handleId, relativePath),
  readText: (handleId, relativePath) => runtime().files.readText(handleId, relativePath),
  readBinary: (input) => runtime().files.readBinary(input),
  beginWrite: (input) => runtime().files.beginWrite(input),
  writeChunk: (input) => runtime().files.writeChunk(input),
  commitWrite: (writeId) => runtime().files.commitWrite(writeId),
  abortWrite: (writeId) => runtime().files.abortWrite(writeId),
  writeText: (handleId, source, relativePath) =>
    runtime().files.writeText(handleId, source, relativePath),
  createDirectory: (handleId, relativePath) =>
    runtime().files.createDirectory(handleId, relativePath),
  watch: (handleId, relativePath, listener) =>
    runtime().files.watch(handleId, relativePath, listener),
};

export const storage: PenkraTabRuntimeApi["storage"] = {
  open: (path) => runtime().storage.open(path),
  closeUrl: (url) => runtime().storage.closeUrl(url),
  writeFile: (input) => runtime().storage.writeFile(input),
  remove: (input) => runtime().storage.remove(input),
  list: (input) => runtime().storage.list(input),
  usage: () => runtime().storage.usage(),
};

export const transfer: PenkraTabRuntimeApi["transfer"] = {
  begin: (input) => runtime().transfer.begin(input),
  send: (input) => runtime().transfer.send(input),
  receive: (input) => runtime().transfer.receive(input),
  onProgress: (listener) => runtime().transfer.onProgress(listener),
};

export const composer: PenkraTabRuntimeApi["composer"] = {
  stage: (input) => runtime().composer.stage(input),
};

export const open: PenkraTabRuntimeApi["open"] = (input) => runtime().open(input);

export const browser: PenkraTabRuntimeApi["browser"] = {
  open: (initialUrl) => runtime().browser.open(initialUrl),
  close: () => runtime().browser.close(),
  getState: () => runtime().browser.getState(),
  onState: (listener) => runtime().browser.onState(listener),
  onDownload: (listener) => runtime().browser.onDownload(listener),
  setSurfaceLayout: (insets) => runtime().browser.setSurfaceLayout(insets),
  navigate: (input) => runtime().browser.navigate(input),
  reload: (pageId) => runtime().browser.reload(pageId),
  stop: (pageId) => runtime().browser.stop(pageId),
  back: (pageId) => runtime().browser.back(pageId),
  forward: (pageId) => runtime().browser.forward(pageId),
  newPage: (input) => runtime().browser.newPage(input),
  closePage: (pageId) => runtime().browser.closePage(pageId),
  selectPage: (pageId) => runtime().browser.selectPage(pageId),
  openExtensionAction: (input) => runtime().browser.openExtensionAction(input),
  find: (input) => runtime().browser.find(input),
  stopFind: (pageId) => runtime().browser.stopFind(pageId),
  capture: (pageId) => runtime().browser.capture(pageId),
  evaluate: (input) => runtime().browser.evaluate(input),
};

export const simulator: PenkraTabRuntimeApi["simulator"] = {
  getEnvironment: () => runtime().simulator.getEnvironment(),
  listRuntimes: () => runtime().simulator.listRuntimes(),
  listDeviceTypes: (runtimeId) => runtime().simulator.listDeviceTypes(runtimeId),
  listDevices: () => runtime().simulator.listDevices(),
  createDevice: (input) => runtime().simulator.createDevice(input),
  eraseDevice: (deviceId) => runtime().simulator.eraseDevice(deviceId),
  deleteDevice: (deviceId) => runtime().simulator.deleteDevice(deviceId),
  requestSetup: (input) => runtime().simulator.requestSetup(input),
  cancelSetup: () => runtime().simulator.cancelSetup(),
  open: (deviceId) => runtime().simulator.open(deviceId),
  close: () => runtime().simulator.close(),
  getState: () => runtime().simulator.getState(),
  onState: (listener) => runtime().simulator.onState(listener),
  setViewport: (bounds) => runtime().simulator.setViewport(bounds),
  getTarget: () => runtime().simulator.getTarget(),
  capture: () => runtime().simulator.capture(),
  tap: (point) => runtime().simulator.tap(point),
  swipe: (input) => runtime().simulator.swipe(input),
  type: (value) => runtime().simulator.type(value),
  press: (button) => runtime().simulator.press(button),
  rotate: (orientation) => runtime().simulator.rotate(orientation),
};

/** Framework-neutral, read-only permission inspection for the current App and Space. */
export const permissions: PenkraTabRuntimeApi["permissions"] = {
  query: (name) => runtime().permissions.query(name),
  request: (name) => runtime().permissions.request(name),
};

/** Installation-local pairwise subject and opaque Space identity for the current App context. */
export const identity: PenkraTabRuntimeApi["identity"] = {
  get: () => runtime().identity.get(),
  getToken: (input) => runtime().identity.getToken(input),
};

export const account: PenkraTabRuntimeApi["account"] = {
  request: (input) => runtime().account.request(input),
  subscribe: (channel, listener, options) =>
    runtime().account.subscribe(channel, listener, options),
};

/** Manifest-declared, Space-scoped App settings. Sensitive values stay in host secure storage. */
export const settings: PenkraTabRuntimeApi["settings"] = {
  get: (key) => runtime().settings.get(key),
  set: (key, value) => runtime().settings.set(key, value),
  reset: (key) => runtime().settings.reset(key),
};

export const secrets: PenkraTabRuntimeApi["secrets"] = {
  get: (name) => runtime().secrets.get(name),
  set: (name, value) => runtime().secrets.set(name, value),
  delete: (name) => runtime().secrets.delete(name),
};

export const network: PenkraTabRuntimeApi["network"] = {
  fetch: (input) => runtime().network.fetch(input),
};

/** Framework-neutral tab registration backed by the host preload bridge. */
export const tab: PenkraTabRuntimeApi["tab"] = {
  getContext: () => runtime().tab.getContext(),
  setRoute: (input) => runtime().tab.setRoute(input),
  onVisibilityChange: (listener) => runtime().tab.onVisibilityChange(listener),
  handle: (operation, handler) => runtime().tab.handle(operation, handler),
  onNavigate: (handler) => runtime().tab.onNavigate(handler),
};

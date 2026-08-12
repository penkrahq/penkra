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

export interface AppFileHandle {
  id: string;
  kind: "file" | "directory";
  name: string;
}

export interface AppFileMetadata {
  name: string;
  kind: "file" | "directory";
  relativePath: string;
  size: number;
  modifiedAt: string;
}

export interface AppFileChangeEvent {
  kind: "changed" | "renamed";
  relativePath: string | null;
}

export interface AppOpenResult {
  destination: "app" | "system";
  appId?: string;
  slug?: string;
}

export interface AppContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  /** Starts a new visual group before this actionable row. */
  separatorBefore?: boolean;
  destructive?: boolean;
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

export interface AppBrowserSessionState {
  version: number;
  open: boolean;
  activePageId: string | null;
  pages: ReadonlyArray<AppBrowserPage>;
  lastError: string | null;
}

export interface AppBrowserFindResult {
  activeMatchOrdinal: number;
  matches: number;
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

export type AppTabNavigationHandler<Result = void> = (
  input: AppTabNavigationInput,
  context: AppTabHandlerContext,
) => Promise<Result> | Result;

export interface PenkraAppRuntimeApi {
  /** Open one authorized file or directory with another compatible App or the operating system. */
  open(input: { handleId: string; relativePath?: string; with?: string }): Promise<AppOpenResult>;
  /** Show a native context menu at the current pointer position. */
  contextMenu: {
    show<T extends string>(items: ReadonlyArray<AppContextMenuItem<T>>): Promise<T | null>;
  };
  /** Permission-bound hosted browser pages. The App owns chrome; Penkra owns page isolation. */
  browser: {
    open(initialUrl?: string): Promise<AppBrowserSessionState>;
    close(): Promise<void>;
    getState(): Promise<AppBrowserSessionState>;
    onState(listener: (state: AppBrowserSessionState) => void): () => void;
    setViewport(
      bounds: { x: number; y: number; width: number; height: number } | null,
    ): Promise<void>;
    navigate(input: { pageId?: string; url: string }): Promise<AppBrowserSessionState>;
    reload(pageId: string): Promise<AppBrowserSessionState>;
    stop(pageId: string): Promise<AppBrowserSessionState>;
    back(pageId: string): Promise<AppBrowserSessionState>;
    forward(pageId: string): Promise<AppBrowserSessionState>;
    newPage(input?: { url?: string; activate?: boolean }): Promise<AppBrowserSessionState>;
    closePage(pageId: string): Promise<AppBrowserSessionState>;
    selectPage(pageId: string): Promise<AppBrowserSessionState>;
    find(input: {
      pageId: string;
      text: string;
      action?: "search" | "next" | "previous";
    }): Promise<AppBrowserFindResult>;
    stopFind(pageId: string): Promise<void>;
    capture(pageId: string): Promise<{ dataUrl: string }>;
    evaluate(input: { pageId: string; expression: string }): Promise<unknown>;
  };
  /** Permission-bound simulated devices. The App owns chrome; Penkra owns native lifecycle. */
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
  };
  /** Credential-hidden access to this App's Account-scoped backend namespace. */
  account: {
    request(input: {
      path: string;
      method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
      body?: string | Uint8Array;
      contentType?: "application/json" | "application/octet-stream";
    }): Promise<AppAccountDataResponse>;
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
  files: {
    pick(kind: "file" | "directory"): Promise<AppFileHandle | null>;
    list(): Promise<ReadonlyArray<AppFileHandle>>;
    readText(handleId: string, relativePath?: string): Promise<string>;
    writeText(handleId: string, contents: string, relativePath?: string): Promise<void>;
    stat(handleId: string, relativePath?: string): Promise<AppFileMetadata>;
    listDirectory(handleId: string, relativePath?: string): Promise<ReadonlyArray<AppFileMetadata>>;
    readBinary(input: {
      handleId: string;
      relativePath?: string;
      offset?: number;
      length?: number;
    }): Promise<{
      bytes: Uint8Array;
      offset: number;
      totalBytes: number;
      complete: boolean;
    }>;
    writeBinary(input: {
      handleId: string;
      relativePath?: string;
      bytes: Uint8Array;
    }): Promise<void>;
    createDirectory(handleId: string, relativePath: string): Promise<AppFileMetadata>;
    rename(
      handleId: string,
      relativePath: string,
      nextRelativePath: string,
    ): Promise<AppFileMetadata>;
    remove(handleId: string, relativePath: string): Promise<void>;
    watch(
      handleId: string,
      relativePath: string | undefined,
      listener: (event: AppFileChangeEvent) => void,
    ): Promise<() => void>;
    openChild(handleId: string, relativePath: string): Promise<AppFileHandle>;
    revoke(handleId: string): Promise<void>;
  };
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
    /** Request a declared optional permission in direct response to a user-invoked feature. */
    request(name: PenkraPermissionName): Promise<AppPermissionStatus>;
  };
  operations: {
    handle<Input = unknown, Result = unknown>(
      handlerKey: string,
      handler: AppOperationHandler<Input, Result>,
    ): () => void;
  };
  tab: {
    /** Record the App's current route so the host can restore it after reloads and updates. */
    setRoute(input: AppTabNavigationInput): Promise<void>;
    handle<Input = unknown, Result = unknown>(
      operation: string,
      handler: AppTabOperationHandler<Input, Result>,
    ): () => void;
    onNavigate<Result = void>(handler: AppTabNavigationHandler<Result>): () => void;
  };
}

function runtime(): PenkraAppRuntimeApi {
  const candidate = (globalThis as { penkra?: PenkraAppRuntimeApi }).penkra;
  if (!candidate) {
    throw new Error("Penkra App runtime is unavailable. Run this package inside Penkra.");
  }
  return candidate;
}

export const open: PenkraAppRuntimeApi["open"] = (input) => runtime().open(input);

export const contextMenu: PenkraAppRuntimeApi["contextMenu"] = {
  show: (items) => runtime().contextMenu.show(items),
};

export const browser: PenkraAppRuntimeApi["browser"] = {
  open: (initialUrl) => runtime().browser.open(initialUrl),
  close: () => runtime().browser.close(),
  getState: () => runtime().browser.getState(),
  onState: (listener) => runtime().browser.onState(listener),
  setViewport: (bounds) => runtime().browser.setViewport(bounds),
  navigate: (input) => runtime().browser.navigate(input),
  reload: (pageId) => runtime().browser.reload(pageId),
  stop: (pageId) => runtime().browser.stop(pageId),
  back: (pageId) => runtime().browser.back(pageId),
  forward: (pageId) => runtime().browser.forward(pageId),
  newPage: (input) => runtime().browser.newPage(input),
  closePage: (pageId) => runtime().browser.closePage(pageId),
  selectPage: (pageId) => runtime().browser.selectPage(pageId),
  find: (input) => runtime().browser.find(input),
  stopFind: (pageId) => runtime().browser.stopFind(pageId),
  capture: (pageId) => runtime().browser.capture(pageId),
  evaluate: (input) => runtime().browser.evaluate(input),
};

export const simulator: PenkraAppRuntimeApi["simulator"] = {
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

/** Framework-neutral operation registration backed by the host preload bridge. */
export const operations: PenkraAppRuntimeApi["operations"] = {
  handle: (handlerKey, handler) => runtime().operations.handle(handlerKey, handler),
};

/** Framework-neutral, read-only permission inspection for the current App and Space. */
export const permissions: PenkraAppRuntimeApi["permissions"] = {
  query: (name) => runtime().permissions.query(name),
  request: (name) => runtime().permissions.request(name),
};

/** Installation-local pairwise subject and opaque Space identity for the current App context. */
export const identity: PenkraAppRuntimeApi["identity"] = {
  get: () => runtime().identity.get(),
};

export const account: PenkraAppRuntimeApi["account"] = {
  request: (input) => runtime().account.request(input),
  subscribe: (channel, listener, options) =>
    runtime().account.subscribe(channel, listener, options),
};

/** Manifest-declared, Space-scoped App settings. Sensitive values stay in host secure storage. */
export const settings: PenkraAppRuntimeApi["settings"] = {
  get: (key) => runtime().settings.get(key),
  set: (key, value) => runtime().settings.set(key, value),
  reset: (key) => runtime().settings.reset(key),
};

export const secrets: PenkraAppRuntimeApi["secrets"] = {
  get: (name) => runtime().secrets.get(name),
  set: (name, value) => runtime().secrets.set(name, value),
  delete: (name) => runtime().secrets.delete(name),
};

export const files: PenkraAppRuntimeApi["files"] = {
  pick: (kind) => runtime().files.pick(kind),
  list: () => runtime().files.list(),
  readText: (handleId, relativePath) => runtime().files.readText(handleId, relativePath),
  writeText: (handleId, contents, relativePath) =>
    runtime().files.writeText(handleId, contents, relativePath),
  stat: (handleId, relativePath) => runtime().files.stat(handleId, relativePath),
  listDirectory: (handleId, relativePath) => runtime().files.listDirectory(handleId, relativePath),
  readBinary: (input) => runtime().files.readBinary(input),
  writeBinary: (input) => runtime().files.writeBinary(input),
  createDirectory: (handleId, relativePath) =>
    runtime().files.createDirectory(handleId, relativePath),
  rename: (handleId, relativePath, nextRelativePath) =>
    runtime().files.rename(handleId, relativePath, nextRelativePath),
  remove: (handleId, relativePath) => runtime().files.remove(handleId, relativePath),
  watch: (handleId, relativePath, listener) =>
    runtime().files.watch(handleId, relativePath, listener),
  openChild: (handleId, relativePath) => runtime().files.openChild(handleId, relativePath),
  revoke: (handleId) => runtime().files.revoke(handleId),
};

export const network: PenkraAppRuntimeApi["network"] = {
  fetch: (input) => runtime().network.fetch(input),
};

/** Framework-neutral tab registration backed by the host preload bridge. */
export const tab: PenkraAppRuntimeApi["tab"] = {
  setRoute: (input) => runtime().tab.setRoute(input),
  handle: (operation, handler) => runtime().tab.handle(operation, handler),
  onNavigate: (handler) => runtime().tab.onNavigate(handler),
};

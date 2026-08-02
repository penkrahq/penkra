import type { OperationContext } from "./operations";
import type { PenkraPermissionName } from "./permissions";

export interface AppPermissionStatus {
  name: PenkraPermissionName;
  declared: boolean;
  required: boolean;
  state: "denied" | "granted";
}

export interface AppIdentity {
  /** Pairwise Account subject. Null while the user is signed out. */
  subject: string | null;
  /** Stable opaque identity for the current Space, scoped to this App. */
  space: string;
}

export interface AppFileHandle {
  id: string;
  kind: "file" | "directory";
  name: string;
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
  identity: {
    get(): Promise<AppIdentity>;
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
    readText(handleId: string): Promise<string>;
    writeText(handleId: string, contents: string): Promise<void>;
    listDirectory(
      handleId: string,
    ): Promise<ReadonlyArray<{ name: string; kind: "file" | "directory" }>>;
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
  sockets: {
    exchange(input: {
      host: string;
      port: number;
      payload: Uint8Array;
      responseBytes?: number;
      timeoutMs?: number;
    }): Promise<Uint8Array>;
  };
  processes: {
    run(input: {
      executableHandleId: string;
      args?: ReadonlyArray<string>;
      cwdHandleId?: string;
      stdin?: string | Uint8Array;
      timeoutMs?: number;
    }): Promise<{
      exitCode: number | null;
      signal: string | null;
      stdout: Uint8Array;
      stderr: Uint8Array;
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

/** Framework-neutral operation registration backed by the host preload bridge. */
export const operations: PenkraAppRuntimeApi["operations"] = {
  handle: (handlerKey, handler) => runtime().operations.handle(handlerKey, handler),
};

/** Framework-neutral, read-only permission inspection for the current App and Space. */
export const permissions: PenkraAppRuntimeApi["permissions"] = {
  query: (name) => runtime().permissions.query(name),
  request: (name) => runtime().permissions.request(name),
};

/** Pairwise Account and opaque Space identity for the current App context. */
export const identity: PenkraAppRuntimeApi["identity"] = {
  get: () => runtime().identity.get(),
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
  readText: (handleId) => runtime().files.readText(handleId),
  writeText: (handleId, contents) => runtime().files.writeText(handleId, contents),
  listDirectory: (handleId) => runtime().files.listDirectory(handleId),
  openChild: (handleId, relativePath) => runtime().files.openChild(handleId, relativePath),
  revoke: (handleId) => runtime().files.revoke(handleId),
};

export const network: PenkraAppRuntimeApi["network"] = {
  fetch: (input) => runtime().network.fetch(input),
};

export const sockets: PenkraAppRuntimeApi["sockets"] = {
  exchange: (input) => runtime().sockets.exchange(input),
};

export const processes: PenkraAppRuntimeApi["processes"] = {
  run: (input) => runtime().processes.run(input),
};

/** Framework-neutral tab registration backed by the host preload bridge. */
export const tab: PenkraAppRuntimeApi["tab"] = {
  handle: (operation, handler) => runtime().tab.handle(operation, handler),
  onNavigate: (handler) => runtime().tab.onNavigate(handler),
};

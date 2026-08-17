// FILE: appPreloadRuntime.ts
// Purpose: Dispatches the narrow public App API inside an isolated preload world.
// Layer: Untrusted App renderer preload

import type {
  AppOperationHandler,
  AppTabNavigationHandler,
  AppTabOperationHandler,
  OperationContext,
  PenkraAppRuntimeApi,
} from "@penkra/sdk";

import type {
  AppRendererRpcContextCallMessage,
  AppRendererRpcHostMessage,
  AppRendererRpcResponseMessage,
} from "./appRendererRpc";

export type AppPreloadRendererMessage =
  | AppRendererRpcResponseMessage
  | AppRendererRpcContextCallMessage;

export interface AppPreloadTransport {
  call?<Result = unknown>(method: string, input?: unknown): Promise<Result>;
  onEvent?(name: string, listener: (payload: unknown) => void): () => void;
  send(message: AppPreloadRendererMessage): void;
  onHostMessage(listener: (message: unknown) => void): () => void;
  ready(): void;
  tabSetRoute(input: import("@penkra/sdk").AppTabNavigationInput): Promise<void>;
  queryPermission(
    name: import("@penkra/sdk").PenkraPermissionName,
  ): Promise<import("@penkra/sdk").AppPermissionStatus>;
  requestPermission(
    name: import("@penkra/sdk").PenkraPermissionName,
  ): Promise<import("@penkra/sdk").AppPermissionStatus>;
  getIdentity(): Promise<import("@penkra/sdk").AppIdentity>;
  accountDataRequest(
    input: Parameters<import("@penkra/sdk").PenkraAppRuntimeApi["account"]["request"]>[0],
  ): ReturnType<import("@penkra/sdk").PenkraAppRuntimeApi["account"]["request"]>;
  accountDataSubscribe(
    channel: string,
    listener: (event: import("@penkra/sdk").AppAccountRealtimeEvent) => void,
    options?: import("@penkra/sdk").AppAccountRealtimeSubscriptionOptions,
  ): Promise<() => void>;
  settingGet(key: string): Promise<boolean | number | string>;
  settingSet(input: { key: string; value: boolean | number | string }): Promise<void>;
  settingReset(key: string): Promise<void>;
  secretGet(name: string): Promise<string | null>;
  secretSet(input: { name: string; value: string }): Promise<void>;
  secretDelete(name: string): Promise<void>;
  browserCall(method: string, input?: unknown): Promise<unknown>;
  onBrowserState(
    listener: (state: import("@penkra/sdk").AppBrowserSessionState) => void,
  ): () => void;
  simulatorCall(method: string, input?: unknown): Promise<unknown>;
  onSimulatorState(
    listener: (state: import("@penkra/sdk").AppSimulatorSessionState) => void,
  ): () => void;
  networkFetch(
    input: Parameters<import("@penkra/sdk").PenkraAppRuntimeApi["network"]["fetch"]>[0],
  ): ReturnType<import("@penkra/sdk").PenkraAppRuntimeApi["network"]["fetch"]>;
  showContextMenu<T extends string>(
    items: ReadonlyArray<import("@penkra/sdk").AppContextMenuItem<T>>,
  ): Promise<T | null>;
}

interface ActiveRequest {
  controller: AbortController;
  contextCalls: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
}

export class AppPreloadRuntime {
  readonly api: PenkraAppRuntimeApi;
  readonly #transport: AppPreloadTransport;
  readonly #operationHandlers = new Map<string, AppOperationHandler>();
  readonly #tabHandlers = new Map<string, AppTabOperationHandler>();
  readonly #active = new Map<string, ActiveRequest>();
  #navigationHandler: AppTabNavigationHandler<unknown> | null = null;
  readonly #navigationHandlerWaiters = new Set<{
    resolve(handler: AppTabNavigationHandler<unknown>): void;
    reject(error: Error): void;
  }>();
  #nextContextCallId = 0;
  #unsubscribe: (() => void) | null = null;
  #ready = false;

  constructor(transport: AppPreloadTransport) {
    this.#transport = transport;
    this.api = {
      contextMenu: {
        show: (items) => this.#transport.showContextMenu(items),
      },
      files: {
        list: () => this.#runtimeV2Call("files.list"),
        pick: (kind) => this.#runtimeV2Call("files.pick", kind),
        revoke: (handleId) => this.#runtimeV2Call("files.revoke", handleId),
        stat: (handleId, relativePath) =>
          this.#runtimeV2Call("files.stat", { handleId, relativePath }),
        listDirectory: (handleId, relativePath) =>
          this.#runtimeV2Call("files.listDirectory", { handleId, relativePath }),
        readText: (handleId, relativePath) =>
          this.#runtimeV2Call("files.readText", { handleId, relativePath }),
        readBinary: (input) => this.#runtimeV2Call("files.readBinary", input),
        writeText: (handleId, source, relativePath) =>
          this.#runtimeV2Call("files.writeText", { handleId, source, relativePath }),
        createDirectory: (handleId, relativePath) =>
          this.#runtimeV2Call("files.createDirectory", { handleId, relativePath }),
        watch: async (handleId, relativePath, listener) => {
          const watchId = await this.#runtimeV2Call<string>("files.watch", {
            handleId,
            relativePath,
          });
          const remove = this.#transport.onEvent?.(`files.watch.${watchId}`, listener);
          return () => {
            remove?.();
            void this.#runtimeV2Call("files.unwatch", { watchId }).catch(() => undefined);
          };
        },
      },
      open: (input) => this.#runtimeV2Call("resources.open", input),
      browser: {
        open: (initialUrl) =>
          this.#transport.browserCall("open", initialUrl) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        close: () => this.#transport.browserCall("close") as Promise<void>,
        getState: () =>
          this.#transport.browserCall("getState") as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        onState: (listener) => this.#transport.onBrowserState(listener),
        setSurfaceLayout: (insets) =>
          this.#transport.browserCall("setSurfaceLayout", insets) as Promise<void>,
        navigate: (input) =>
          this.#transport.browserCall("navigate", input) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        reload: (pageId) =>
          this.#transport.browserCall("reload", pageId) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        stop: (pageId) =>
          this.#transport.browserCall("stop", pageId) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        back: (pageId) =>
          this.#transport.browserCall("back", pageId) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        forward: (pageId) =>
          this.#transport.browserCall("forward", pageId) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        newPage: (input) =>
          this.#transport.browserCall("newPage", input) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        closePage: (pageId) =>
          this.#transport.browserCall("closePage", pageId) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        selectPage: (pageId) =>
          this.#transport.browserCall("selectPage", pageId) as Promise<
            import("@penkra/sdk").AppBrowserSessionState
          >,
        find: (input) =>
          this.#transport.browserCall("find", input) as Promise<
            import("@penkra/sdk").AppBrowserFindResult
          >,
        stopFind: (pageId) => this.#transport.browserCall("stopFind", pageId) as Promise<void>,
        capture: (pageId) =>
          this.#transport.browserCall("capture", pageId) as Promise<{ dataUrl: string }>,
        evaluate: (input) => this.#transport.browserCall("evaluate", input),
      },
      simulator: {
        getEnvironment: () =>
          this.#transport.simulatorCall("getEnvironment") as Promise<
            import("@penkra/sdk").AppSimulatorEnvironment
          >,
        listRuntimes: () =>
          this.#transport.simulatorCall("listRuntimes") as Promise<
            ReadonlyArray<import("@penkra/sdk").AppSimulatorRuntime>
          >,
        listDeviceTypes: (runtimeId) =>
          this.#transport.simulatorCall("listDeviceTypes", runtimeId) as Promise<
            ReadonlyArray<import("@penkra/sdk").AppSimulatorDeviceType>
          >,
        listDevices: () =>
          this.#transport.simulatorCall("listDevices") as Promise<
            ReadonlyArray<import("@penkra/sdk").AppSimulatorSavedDevice>
          >,
        createDevice: (input) =>
          this.#transport.simulatorCall("createDevice", input) as Promise<
            import("@penkra/sdk").AppSimulatorSavedDevice
          >,
        eraseDevice: (deviceId) =>
          this.#transport.simulatorCall("eraseDevice", deviceId) as Promise<
            import("@penkra/sdk").AppSimulatorSavedDevice
          >,
        deleteDevice: (deviceId) =>
          this.#transport.simulatorCall("deleteDevice", deviceId) as Promise<void>,
        requestSetup: (input) =>
          this.#transport.simulatorCall("requestSetup", input) as Promise<
            import("@penkra/sdk").AppSimulatorEnvironment
          >,
        cancelSetup: () => this.#transport.simulatorCall("cancelSetup") as Promise<void>,
        open: (deviceId) =>
          this.#transport.simulatorCall("open", deviceId) as Promise<
            import("@penkra/sdk").AppSimulatorSessionState
          >,
        close: () => this.#transport.simulatorCall("close") as Promise<void>,
        getState: () =>
          this.#transport.simulatorCall("getState") as Promise<
            import("@penkra/sdk").AppSimulatorSessionState
          >,
        onState: (listener) => this.#transport.onSimulatorState(listener),
        setViewport: (bounds) =>
          this.#transport.simulatorCall("setViewport", bounds) as Promise<void>,
        getTarget: () =>
          this.#transport.simulatorCall("getTarget") as Promise<
            import("@penkra/sdk").AppSimulatorTarget
          >,
        capture: () => this.#transport.simulatorCall("capture") as Promise<{ dataUrl: string }>,
        tap: (point) => this.#transport.simulatorCall("tap", point) as Promise<void>,
        swipe: (input) => this.#transport.simulatorCall("swipe", input) as Promise<void>,
        type: (text) => this.#transport.simulatorCall("type", text) as Promise<void>,
        press: (button) => this.#transport.simulatorCall("press", button) as Promise<void>,
        rotate: (orientation) =>
          this.#transport.simulatorCall("rotate", orientation) as Promise<
            import("@penkra/sdk").AppSimulatorSessionState
          >,
      },
      identity: {
        get: () => this.#transport.getIdentity(),
      },
      account: {
        request: (input) => this.#transport.accountDataRequest(input),
        subscribe: (channel, listener, options) =>
          this.#transport.accountDataSubscribe(channel, listener, options),
      },
      settings: {
        get: (key) => this.#transport.settingGet(key),
        set: (key, value) => this.#transport.settingSet({ key, value }),
        reset: (key) => this.#transport.settingReset(key),
      },
      secrets: {
        get: (name) => this.#transport.secretGet(name),
        set: (name, value) => this.#transport.secretSet({ name, value }),
        delete: (name) => this.#transport.secretDelete(name),
      },
      network: {
        fetch: (input) => this.#transport.networkFetch(input),
      },
      permissions: {
        query: (name) => this.#transport.queryPermission(name),
        request: (name) => this.#transport.requestPermission(name),
      },
      operations: {
        handle: (handlerKey, handler) =>
          registerUnique(
            this.#operationHandlers,
            handlerKey,
            handler as AppOperationHandler,
            "operation handler",
          ),
      },
      tab: {
        setRoute: (input) => this.#transport.tabSetRoute(input),
        handle: (operation, handler) =>
          registerUnique(
            this.#tabHandlers,
            operation,
            handler as AppTabOperationHandler,
            "tab handler",
          ),
        onNavigate: (handler) => {
          if (typeof handler !== "function")
            throw new TypeError("Navigation handler must be a function.");
          if (this.#navigationHandler)
            throw new Error("A tab navigation handler is already registered.");
          this.#navigationHandler = handler as AppTabNavigationHandler<unknown>;
          for (const waiter of this.#navigationHandlerWaiters) {
            waiter.resolve(this.#navigationHandler);
          }
          this.#navigationHandlerWaiters.clear();
          return () => {
            if (this.#navigationHandler === handler) this.#navigationHandler = null;
          };
        },
      },
    };
  }

  #runtimeV2Call<Result = void>(method: string, input?: unknown): Promise<Result> {
    if (!this.#transport.call) {
      return Promise.reject(new Error("This capability requires Penkra Runtime v2."));
    }
    return this.#transport.call<Result>(method, input);
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#transport.onHostMessage((message) =>
      this.#acceptHostMessage(message),
    );
  }

  markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#transport.ready();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#ready = false;
    for (const waiter of this.#navigationHandlerWaiters) {
      waiter.reject(new Error("Penkra App runtime stopped."));
    }
    this.#navigationHandlerWaiters.clear();
    for (const [id, request] of this.#active) {
      request.controller.abort(new Error("Penkra App runtime stopped."));
      this.#rejectContextCalls(request, new Error("Penkra App runtime stopped."));
      this.#active.delete(id);
    }
  }

  #acceptHostMessage(candidate: unknown): void {
    if (!isRecord(candidate) || typeof candidate.type !== "string") return;
    if (candidate.type === "request") {
      void this.#dispatchRequest(candidate);
      return;
    }
    if (candidate.type === "cancel") {
      const requestId = typeof candidate.id === "string" ? candidate.id : "";
      const request = requestId ? this.#active.get(requestId) : undefined;
      if (!request) return;
      const reason =
        typeof candidate.reason === "string" ? candidate.reason : "operation-cancelled";
      const error = Object.assign(new Error(`App request cancelled: ${reason}.`), {
        code: reason.toUpperCase().replaceAll("-", "_"),
      });
      request.controller.abort(error);
      this.#rejectContextCalls(request, error);
      if (this.#active.get(requestId) === request) this.#active.delete(requestId);
      return;
    }
    if (candidate.type === "context-result" || candidate.type === "context-error") {
      this.#settleContextCall(candidate);
    }
  }

  async #dispatchRequest(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === "string" ? message.id : "";
    if (!id || this.#active.has(id)) return;
    const method = message.method;
    const request: ActiveRequest = {
      controller: new AbortController(),
      contextCalls: new Map(),
    };
    this.#active.set(id, request);
    try {
      let result: unknown;
      if (method === "controller.invoke") {
        result = await this.#invokeController(id, request, message.input);
      } else if (method === "tab.invoke") {
        result = await this.#invokeTab(request, message.input);
      } else if (method === "tab.navigate" || method === "tab.navigate-for-result") {
        result = await this.#navigateTab(request, message.input);
      } else {
        throw runtimeError("METHOD_NOT_SUPPORTED", "App renderer request method is not supported.");
      }
      if (!request.controller.signal.aborted) {
        this.#transport.send({ type: "result", id, result: result ?? null });
      }
    } catch (error) {
      if (!request.controller.signal.aborted) {
        const publicError = serializeError(error);
        this.#transport.send({ type: "error", id, ...publicError });
      }
    } finally {
      this.#rejectContextCalls(request, new Error("Parent App request settled."));
      if (this.#active.get(id) === request) this.#active.delete(id);
    }
  }

  async #invokeController(
    parentId: string,
    request: ActiveRequest,
    value: unknown,
  ): Promise<unknown> {
    const input = requireRecord(value);
    const handlerKey = requireString(input.handler, "handler");
    const handler = this.#operationHandlers.get(handlerKey);
    if (!handler)
      throw runtimeError(
        "HANDLER_NOT_REGISTERED",
        `Operation handler ${handlerKey} is not registered.`,
      );
    const invocation = parseInvocation(input.invocation);
    const context = this.#operationContext(
      parentId,
      request,
      invocation,
      parseCaller(input.caller),
    );
    return handler(input.input, context);
  }

  async #invokeTab(request: ActiveRequest, value: unknown): Promise<unknown> {
    const input = requireRecord(value);
    const operation = requireString(input.operation, "operation");
    const handler = this.#tabHandlers.get(operation);
    if (!handler)
      throw runtimeError(
        "TAB_HANDLER_NOT_REGISTERED",
        `Tab handler ${operation} is not registered.`,
      );
    return handler(input.input, { signal: request.controller.signal });
  }

  async #navigateTab(request: ActiveRequest, value: unknown): Promise<unknown> {
    const handler =
      this.#navigationHandler ?? (await this.#waitForNavigationHandler(request.controller.signal));
    const input = requireRecord(value);
    return handler(
      {
        route: requireString(input.route, "route"),
        ...(input.state === undefined ? {} : { state: input.state }),
      },
      { signal: request.controller.signal },
    );
  }

  #waitForNavigationHandler(signal: AbortSignal): Promise<AppTabNavigationHandler<unknown>> {
    if (signal.aborted) return Promise.reject(toError(signal.reason));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const abort = () => {
        this.#navigationHandlerWaiters.delete(waiter);
        reject(toError(signal.reason));
      };
      waiter.resolve = (handler) => {
        signal.removeEventListener("abort", abort);
        resolve(handler);
      };
      waiter.reject = (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      };
      this.#navigationHandlerWaiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  #operationContext(
    parentId: string,
    request: ActiveRequest,
    invocation: OperationContext["invocation"],
    caller: OperationContext["caller"],
  ): OperationContext {
    const targetTab = invocation.tabId
      ? this.#tabHandle(parentId, request, invocation.tabId, false)
      : undefined;
    return {
      invocation,
      caller,
      ...(targetTab ? { tab: targetTab } : {}),
      tabs: {
        open: async (input) => {
          const result = requireRecord(
            await this.#contextCall(parentId, request, "context.tabs.open", input),
          );
          const id = requireString(result.id, "id");
          return this.#tabHandle(parentId, request, id, true);
        },
        openForResult: <Result = unknown>(input: { route: string; state?: unknown }) =>
          this.#contextCall(
            parentId,
            request,
            "context.tabs.open-for-result",
            input,
          ) as Promise<Result>,
      },
      operations: {
        invoke: <Result = unknown>(input: import("@penkra/sdk").OperationRequest) =>
          this.#contextCall(
            parentId,
            request,
            "context.operations.invoke",
            input,
          ) as Promise<Result>,
      },
      signal: request.controller.signal,
    };
  }

  #tabHandle(
    parentId: string,
    request: ActiveRequest,
    id: string,
    opened: boolean,
  ): import("@penkra/sdk").AppTabHandle {
    const withHandle = (input: Record<string, unknown>) =>
      opened ? { ...input, handleId: id } : input;
    return {
      id,
      navigate: async (input: { route: string; state?: unknown }) => {
        await this.#contextCall(parentId, request, "context.tab.navigate", withHandle(input));
      },
      navigateForResult: <Result = unknown>(input: { route: string; state?: unknown }) =>
        this.#contextCall(
          parentId,
          request,
          "context.tab.navigate-for-result",
          withHandle(input),
        ) as Promise<Result>,
      invoke: <Result = unknown>(input: { operation: string; input: unknown }) =>
        this.#contextCall(
          parentId,
          request,
          "context.tab.invoke",
          withHandle(input),
        ) as Promise<Result>,
    };
  }

  #contextCall(
    parentId: string,
    request: ActiveRequest,
    method: AppRendererRpcContextCallMessage["method"],
    input: unknown,
  ): Promise<unknown> {
    if (request.controller.signal.aborted) return Promise.reject(request.controller.signal.reason);
    const id = `context-${++this.#nextContextCallId}`;
    return new Promise((resolve, reject) => {
      request.contextCalls.set(id, { resolve, reject });
      try {
        this.#transport.send({ type: "context-call", parentId, id, method, input });
      } catch (error) {
        request.contextCalls.delete(id);
        reject(error);
      }
    });
  }

  #settleContextCall(message: Record<string, unknown>): void {
    if (typeof message.parentId !== "string" || typeof message.id !== "string") return;
    const request = this.#active.get(message.parentId);
    const pending = request?.contextCalls.get(message.id);
    if (!request || !pending) return;
    request.contextCalls.delete(message.id);
    if (message.type === "context-result") {
      pending.resolve(message.result);
    } else {
      pending.reject(
        runtimeError(
          typeof message.code === "string" ? message.code : "CONTEXT_CALL_FAILED",
          typeof message.message === "string" ? message.message : "App context call failed.",
        ),
      );
    }
  }

  #rejectContextCalls(request: ActiveRequest, error: Error): void {
    for (const pending of request.contextCalls.values()) pending.reject(error);
    request.contextCalls.clear();
  }
}

function registerUnique<Handler>(
  handlers: Map<string, Handler>,
  key: string,
  handler: Handler,
  label: string,
): () => void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new TypeError(`${label} key must be a non-empty string.`);
  }
  if (typeof handler !== "function") throw new TypeError(`${label} must be a function.`);
  if (handlers.has(key)) throw new Error(`${label} ${key} is already registered.`);
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key);
  };
}

function parseInvocation(value: unknown): OperationContext["invocation"] {
  const input = requireRecord(value);
  return {
    id: requireString(input.id, "invocation.id"),
    app: requireString(input.app, "invocation.app"),
    operation: requireString(input.operation, "invocation.operation"),
    spaceId: requireString(input.spaceId, "invocation.spaceId"),
    threadId: requireString(input.threadId, "invocation.threadId"),
    ...(input.tabId === undefined ? {} : { tabId: requireString(input.tabId, "invocation.tabId") }),
  };
}

function parseCaller(value: unknown): OperationContext["caller"] {
  const input = requireRecord(value);
  const kind = requireString(input.kind, "caller.kind");
  if (kind !== "user" && kind !== "agent" && kind !== "app" && kind !== "host") {
    throw runtimeError("INVALID_REQUEST", "caller.kind is invalid.");
  }
  return {
    kind,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw runtimeError("INVALID_REQUEST", "App runtime request must be an object.");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw runtimeError("INVALID_REQUEST", `${label} must be a non-empty string.`);
  }
  return value;
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code =
      isRecord(error) && typeof error.code === "string" ? error.code : "APP_HANDLER_FAILED";
    return {
      code: /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : "APP_HANDLER_FAILED",
      message: error.message.slice(0, 2_048),
    };
  }
  return { code: "APP_HANDLER_FAILED", message: String(error).slice(0, 2_048) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

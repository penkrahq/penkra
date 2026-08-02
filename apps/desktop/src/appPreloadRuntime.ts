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
  send(message: AppPreloadRendererMessage): void;
  onHostMessage(listener: (message: unknown) => void): () => void;
  ready(): void;
}

interface ActiveRequest {
  controller: AbortController;
  contextCalls: Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >;
}

export class AppPreloadRuntime {
  readonly api: PenkraAppRuntimeApi;
  readonly #transport: AppPreloadTransport;
  readonly #operationHandlers = new Map<string, AppOperationHandler>();
  readonly #tabHandlers = new Map<string, AppTabOperationHandler>();
  readonly #active = new Map<string, ActiveRequest>();
  #navigationHandler: AppTabNavigationHandler | null = null;
  #nextContextCallId = 0;
  #unsubscribe: (() => void) | null = null;
  #ready = false;

  constructor(transport: AppPreloadTransport) {
    this.#transport = transport;
    this.api = {
      operations: {
        handle: (handlerKey, handler) =>
          registerUnique(this.#operationHandlers, handlerKey, handler, "operation handler"),
      },
      tab: {
        handle: (operation, handler) =>
          registerUnique(this.#tabHandlers, operation, handler, "tab handler"),
        onNavigate: (handler) => {
          if (typeof handler !== "function") throw new TypeError("Navigation handler must be a function.");
          if (this.#navigationHandler) throw new Error("A tab navigation handler is already registered.");
          this.#navigationHandler = handler;
          return () => {
            if (this.#navigationHandler === handler) this.#navigationHandler = null;
          };
        },
      },
    };
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#transport.onHostMessage((message) => this.#acceptHostMessage(message));
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
      const reason = typeof candidate.reason === "string" ? candidate.reason : "operation-cancelled";
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
    if (!handler) throw runtimeError("HANDLER_NOT_REGISTERED", `Operation handler ${handlerKey} is not registered.`);
    const invocation = parseInvocation(input.invocation);
    const context = this.#operationContext(parentId, request, invocation);
    return handler(input.input, context);
  }

  async #invokeTab(request: ActiveRequest, value: unknown): Promise<unknown> {
    const input = requireRecord(value);
    const operation = requireString(input.operation, "operation");
    const handler = this.#tabHandlers.get(operation);
    if (!handler) throw runtimeError("TAB_HANDLER_NOT_REGISTERED", `Tab handler ${operation} is not registered.`);
    return handler(input.input, { signal: request.controller.signal });
  }

  async #navigateTab(request: ActiveRequest, value: unknown): Promise<unknown> {
    if (!this.#navigationHandler) {
      throw runtimeError("NAVIGATION_HANDLER_NOT_REGISTERED", "A tab navigation handler is not registered.");
    }
    const input = requireRecord(value);
    return this.#navigationHandler(
      {
        route: requireString(input.route, "route"),
        ...(input.state === undefined ? {} : { state: input.state }),
      },
      { signal: request.controller.signal },
    );
  }

  #operationContext(
    parentId: string,
    request: ActiveRequest,
    invocation: OperationContext["invocation"],
  ): OperationContext {
    const targetTab = invocation.tabId
      ? this.#tabHandle(parentId, request, invocation.tabId, false)
      : undefined;
    return {
      invocation,
      ...(targetTab ? { tab: targetTab } : {}),
      tabs: {
        open: async (input) => {
          const result = requireRecord(
            await this.#contextCall(parentId, request, "context.tabs.open", input),
          );
          const id = requireString(result.id, "id");
          return this.#tabHandle(parentId, request, id, true);
        },
        openForResult: (input) =>
          this.#contextCall(parentId, request, "context.tabs.open-for-result", input),
      },
      signal: request.controller.signal,
    };
  }

  #tabHandle(parentId: string, request: ActiveRequest, id: string, opened: boolean) {
    const withHandle = (input: Record<string, unknown>) =>
      opened ? { ...input, handleId: id } : input;
    return {
      id,
      navigate: async (input: { route: string; state?: unknown }) => {
        await this.#contextCall(
          parentId,
          request,
          "context.tab.navigate",
          withHandle(input),
        );
      },
      navigateForResult: (input: { route: string; state?: unknown }) =>
        this.#contextCall(
          parentId,
          request,
          "context.tab.navigate-for-result",
          withHandle(input),
        ),
      invoke: (input: { operation: string; input: unknown }) =>
        this.#contextCall(
          parentId,
          request,
          "context.tab.invoke",
          withHandle(input),
        ),
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

function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "APP_HANDLER_FAILED";
    return { code: /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : "APP_HANDLER_FAILED", message: error.message.slice(0, 2_048) };
  }
  return { code: "APP_HANDLER_FAILED", message: String(error).slice(0, 2_048) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// FILE: appNodeControllerRuntime.ts
// Purpose: Implements the public Penkra SDK and operation RPC inside a Node App controller.
// Layer: App controller process

import type { AppTabHandle, OperationContext, PenkraAppRuntimeApi } from "@penkra/sdk";

import type {
  AppRendererRpcContextCallMessage,
  AppRendererRpcHostMessage,
  AppRendererRpcResponseMessage,
} from "./appRendererRpc";

export interface AppNodeControllerTransport {
  send(message: AppRendererRpcResponseMessage | AppRendererRpcContextCallMessage): void;
  onHostMessage(listener: (message: unknown) => void): () => void;
  serviceCall<Result = unknown>(method: string, input?: unknown): Promise<Result>;
  ready(): void;
}

interface ActiveRequest {
  controller: AbortController;
  contextCalls: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
}

type RegisteredOperationHandler = (
  input: unknown,
  context: OperationContext,
) => unknown | Promise<unknown>;

export class AppNodeControllerRuntime {
  readonly api: PenkraAppRuntimeApi;
  readonly #transport: AppNodeControllerTransport;
  readonly #handlers = new Map<string, RegisteredOperationHandler>();
  readonly #active = new Map<string, ActiveRequest>();
  #nextContextCallId = 0;
  #unsubscribe: (() => void) | null = null;
  #ready = false;

  constructor(transport: AppNodeControllerTransport) {
    this.#transport = transport;
    const unsupported = (name: string) => () =>
      Promise.reject(
        Object.assign(new Error(`${name} is available only in an interactive App tab.`), {
          code: "INTERACTIVE_TAB_REQUIRED",
        }),
      );
    this.api = {
      identity: {
        get: () => transport.serviceCall("identity.get"),
        getToken: (input) => transport.serviceCall("identity.getToken", input),
      },
      account: {
        request: (input) => transport.serviceCall("account.request", input),
        subscribe: unsupported("Account realtime subscriptions") as never,
      },
      settings: {
        get: (key) => transport.serviceCall("settings.get", key),
        set: (key, value) => transport.serviceCall("settings.set", { key, value }),
        reset: (key) => transport.serviceCall("settings.reset", key),
      },
      secrets: {
        get: (name) => transport.serviceCall("secrets.get", name),
        set: (name, value) => transport.serviceCall("secrets.set", { name, value }),
        delete: (name) => transport.serviceCall("secrets.delete", name),
      },
      permissions: {
        query: (name) => transport.serviceCall("permissions.query", name),
        request: unsupported("Permission prompts") as never,
      },
      operations: {
        handle: (key, handler) =>
          registerUnique(this.#handlers, key, handler as RegisteredOperationHandler),
      },
      files: unsupportedSurface("files"),
      storage: unsupportedSurface("storage"),
      transfer: unsupportedSurface("transfer"),
      composer: unsupportedSurface("composer"),
      open: unsupported("Resource opening") as never,
      browser: unsupportedSurface("browser"),
      simulator: unsupportedSurface("simulator"),
      network: unsupportedSurface("network"),
      contextMenu: unsupportedSurface("contextMenu"),
      tab: unsupportedSurface("tab"),
    } as PenkraAppRuntimeApi;
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#transport.onHostMessage((message) => this.#accept(message));
  }

  markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#transport.ready();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const request of this.#active.values()) {
      request.controller.abort(new Error("Penkra App controller stopped."));
      rejectContextCalls(request, new Error("Penkra App controller stopped."));
    }
    this.#active.clear();
  }

  #accept(candidate: unknown): void {
    if (!isRecord(candidate) || typeof candidate.type !== "string") return;
    if (candidate.type === "request") {
      void this.#dispatch(candidate);
      return;
    }
    if (candidate.type === "cancel") {
      const id = typeof candidate.id === "string" ? candidate.id : "";
      const request = this.#active.get(id);
      if (!request) return;
      const reason =
        typeof candidate.reason === "string" ? candidate.reason : "operation-cancelled";
      const error = Object.assign(new Error(`App request cancelled: ${reason}.`), {
        code: reason.toUpperCase().replaceAll("-", "_"),
      });
      request.controller.abort(error);
      rejectContextCalls(request, error);
      this.#active.delete(id);
      return;
    }
    if (candidate.type === "context-result" || candidate.type === "context-error") {
      this.#settleContextCall(candidate);
    }
  }

  async #dispatch(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === "string" ? message.id : "";
    if (!id || this.#active.has(id)) return;
    const request: ActiveRequest = { controller: new AbortController(), contextCalls: new Map() };
    this.#active.set(id, request);
    try {
      if (message.method !== "controller.invoke") {
        throw runtimeError(
          "METHOD_NOT_SUPPORTED",
          "Node controllers accept operation invocations only.",
        );
      }
      const input = requireRecord(message.input);
      const handlerKey = requireString(input.handler, "handler");
      const handler = this.#handlers.get(handlerKey);
      if (!handler) {
        throw runtimeError(
          "HANDLER_NOT_REGISTERED",
          `Operation handler ${handlerKey} is not registered.`,
        );
      }
      const invocation = parseInvocation(input.invocation);
      const result = await handler(
        input.input,
        this.#operationContext(id, request, invocation, parseCaller(input.caller)),
      );
      if (!request.controller.signal.aborted) {
        this.#transport.send({ type: "result", id, result: result ?? null });
      }
    } catch (error) {
      if (!request.controller.signal.aborted) {
        this.#transport.send({ type: "error", id, ...serializeError(error) });
      }
    } finally {
      rejectContextCalls(request, new Error("Parent App request settled."));
      if (this.#active.get(id) === request) this.#active.delete(id);
    }
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
          return this.#tabHandle(parentId, request, requireString(result.id, "id"), true);
        },
        openForResult: (input) =>
          this.#contextCall(parentId, request, "context.tabs.open-for-result", input) as never,
      },
      operations: {
        invoke: (input) =>
          this.#contextCall(parentId, request, "context.operations.invoke", input) as never,
      },
      signal: request.controller.signal,
    };
  }

  #tabHandle(parentId: string, request: ActiveRequest, id: string, opened: boolean): AppTabHandle {
    const withHandle = (input: Record<string, unknown>) =>
      opened ? { ...input, handleId: id } : input;
    return {
      id,
      close: () =>
        this.#contextCall(parentId, request, "context.tab.close", withHandle({})) as Promise<void>,
      navigate: (input) =>
        this.#contextCall(
          parentId,
          request,
          "context.tab.navigate",
          withHandle(input),
        ) as Promise<void>,
      navigateForResult: (input) =>
        this.#contextCall(
          parentId,
          request,
          "context.tab.navigate-for-result",
          withHandle(input),
        ) as never,
      invoke: (input) =>
        this.#contextCall(parentId, request, "context.tab.invoke", withHandle(input)) as never,
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
      this.#transport.send({ type: "context-call", parentId, id, method, input });
    });
  }

  #settleContextCall(message: Record<string, unknown>): void {
    if (typeof message.parentId !== "string" || typeof message.id !== "string") return;
    const request = this.#active.get(message.parentId);
    const pending = request?.contextCalls.get(message.id);
    if (!request || !pending) return;
    request.contextCalls.delete(message.id);
    if (message.type === "context-result") pending.resolve(message.result);
    else {
      pending.reject(
        runtimeError(
          typeof message.code === "string" ? message.code : "CONTEXT_CALL_FAILED",
          typeof message.message === "string" ? message.message : "App context call failed.",
        ),
      );
    }
  }
}

function unsupportedSurface(name: string): never {
  return new Proxy(
    {},
    {
      get: () => () =>
        Promise.reject(
          Object.assign(new Error(`${name} is available only in an interactive App tab.`), {
            code: "INTERACTIVE_TAB_REQUIRED",
          }),
        ),
    },
  ) as never;
}

function registerUnique(
  handlers: Map<string, RegisteredOperationHandler>,
  key: string,
  handler: RegisteredOperationHandler,
): () => void {
  if (typeof key !== "string" || key.trim().length === 0)
    throw new TypeError("Operation handler key must be a non-empty string.");
  if (typeof handler !== "function") throw new TypeError("Operation handler must be a function.");
  if (handlers.has(key)) throw new Error(`Operation handler ${key} is already registered.`);
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
  const kind = requireString(requireRecord(value).kind, "caller.kind");
  if (kind !== "user" && kind !== "agent" && kind !== "app" && kind !== "host") {
    throw runtimeError("INVALID_REQUEST", "caller.kind is invalid.");
  }
  return { kind };
}

function rejectContextCalls(request: ActiveRequest, error: Error): void {
  for (const pending of request.contextCalls.values()) pending.reject(error);
  request.contextCalls.clear();
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw runtimeError("INVALID_REQUEST", "App request input must be an object.");
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw runtimeError("INVALID_REQUEST", `${label} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function serializeError(error: unknown): { code: string; message: string } {
  return {
    code: isRecord(error) && typeof error.code === "string" ? error.code : "APP_OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

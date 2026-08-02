// FILE: appRendererRpc.ts
// Purpose: Provides bounded point-to-point request/result transport to one registered App renderer.
// Layer: Trusted desktop App runtime

import { randomUUID } from "node:crypto";

import type { OperationCancellationCode } from "@penkra/sdk";

export const APP_RENDERER_RPC_METHODS = [
  "controller.invoke",
  "tab.invoke",
  "tab.navigate",
  "tab.navigate-for-result",
] as const;

export type AppRendererRpcMethod = (typeof APP_RENDERER_RPC_METHODS)[number];

export const APP_RENDERER_CONTEXT_METHODS = [
  "context.tab.invoke",
  "context.tab.navigate",
  "context.tab.navigate-for-result",
  "context.tabs.open",
  "context.tabs.open-for-result",
] as const;

export type AppRendererContextMethod = (typeof APP_RENDERER_CONTEXT_METHODS)[number];

export interface AppRendererRpcRequestMessage {
  type: "request";
  id: string;
  method: AppRendererRpcMethod;
  input: unknown;
}

export interface AppRendererRpcCancelMessage {
  type: "cancel";
  id: string;
  reason: OperationCancellationCode;
}

export type AppRendererRpcContextResponseMessage =
  | { type: "context-result"; parentId: string; id: string; result: unknown }
  | {
      type: "context-error";
      parentId: string;
      id: string;
      code: string;
      message: string;
    };

export type AppRendererRpcHostMessage =
  | AppRendererRpcRequestMessage
  | AppRendererRpcCancelMessage
  | AppRendererRpcContextResponseMessage;

export type AppRendererRpcResponseMessage =
  | { type: "result"; id: string; result: unknown }
  | { type: "error"; id: string; code: string; message: string };

export interface AppRendererRpcContextCallMessage {
  type: "context-call";
  parentId: string;
  id: string;
  method: AppRendererContextMethod;
  input: unknown;
}

export interface AppRendererRpcTarget {
  /** Host-owned renderer identity, conventionally Electron webContents.id. */
  id: number;
  send(message: AppRendererRpcHostMessage): void;
}

export interface AppRendererRpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  handleContextCall?: (
    method: AppRendererContextMethod,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
}

export type AppRendererRpcErrorCode =
  | "duplicate-target"
  | "host-stopped"
  | "invalid-message"
  | "payload-too-large"
  | "renderer-error"
  | "renderer-unavailable"
  | "target-overloaded"
  | "timeout";

export class AppRendererRpcError extends Error {
  readonly code: AppRendererRpcErrorCode;
  readonly rendererCode?: string;

  constructor(code: AppRendererRpcErrorCode, message: string, rendererCode?: string) {
    super(message);
    this.name = "AppRendererRpcError";
    this.code = code;
    this.rendererCode = rendererCode;
  }
}

export interface AppRendererRpcHostOptions {
  maxPayloadBytes?: number;
  maxPendingPerTarget?: number;
  defaultTimeoutMs?: number;
  mintRequestId?: () => string;
}

interface PendingRequest {
  targetId: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  contextController: AbortController;
  handleContextCall?: AppRendererRpcRequestOptions["handleContextCall"];
  activeContextCalls: Set<string>;
  seenContextCalls: Set<string>;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_PER_TARGET = 128;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CONTEXT_CALLS_PER_REQUEST = 32;
const MAX_TOTAL_CONTEXT_CALLS_PER_REQUEST = 1_024;

export class AppRendererRpcHost {
  readonly #targets = new Map<number, AppRendererRpcTarget>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #maxPayloadBytes: number;
  readonly #maxPendingPerTarget: number;
  readonly #defaultTimeoutMs: number;
  readonly #mintRequestId: () => string;
  #stopped = false;

  constructor(options: AppRendererRpcHostOptions = {}) {
    this.#maxPayloadBytes = positiveInteger(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
    );
    this.#maxPendingPerTarget = positiveInteger(
      options.maxPendingPerTarget ?? DEFAULT_MAX_PENDING_PER_TARGET,
      "maxPendingPerTarget",
    );
    this.#defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.#mintRequestId = options.mintRequestId ?? randomUUID;
  }

  registerTarget(target: AppRendererRpcTarget): (reason?: OperationCancellationCode) => void {
    if (this.#stopped) {
      throw new AppRendererRpcError("host-stopped", "App renderer RPC host is stopped.");
    }
    if (this.#targets.has(target.id)) {
      throw new AppRendererRpcError(
        "duplicate-target",
        `App renderer target ${target.id} is already registered.`,
      );
    }
    this.#targets.set(target.id, target);
    return (reason = "tab-closed") => {
      if (this.#targets.get(target.id) !== target) return;
      this.#cancelTarget(target.id, reason, "App renderer target closed.");
      this.#targets.delete(target.id);
    };
  }

  async request<Result = unknown>(
    targetId: number,
    method: AppRendererRpcMethod,
    input: unknown,
    options: AppRendererRpcRequestOptions = {},
  ): Promise<Result> {
    if (this.#stopped) {
      throw new AppRendererRpcError("host-stopped", "App renderer RPC host is stopped.");
    }
    const target = this.#targets.get(targetId);
    if (!target) {
      throw new AppRendererRpcError(
        "renderer-unavailable",
        `App renderer target ${targetId} is unavailable.`,
      );
    }
    assertPayloadSize(input, this.#maxPayloadBytes);
    if (this.#pendingCount(targetId) >= this.#maxPendingPerTarget) {
      throw new AppRendererRpcError(
        "target-overloaded",
        `App renderer target ${targetId} has too many pending requests.`,
      );
    }
    if (options.signal?.aborted) {
      throw abortError(options.signal.reason);
    }

    const id = this.#mintUniqueRequestId();
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.#defaultTimeoutMs, "timeoutMs");
    return new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#cancelRequest(id, "timeout", new AppRendererRpcError("timeout", "App request timed out."));
      }, timeoutMs);
      const pending: PendingRequest = {
        targetId,
        resolve,
        reject,
        timeout,
        signal: options.signal,
        contextController: new AbortController(),
        handleContextCall: options.handleContextCall,
        activeContextCalls: new Set(),
        seenContextCalls: new Set(),
      };
      if (options.signal) {
        pending.abortListener = () => {
          this.#cancelRequest(id, "operation-cancelled", abortError(options.signal?.reason));
        };
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.#pending.set(id, pending);
      try {
        target.send({ type: "request", id, method, input });
      } catch (error) {
        this.#settle(id);
        reject(toError(error));
      }
    });
  }

  acceptResponse(senderTargetId: number, candidate: unknown): boolean {
    const response = parseResponse(candidate, this.#maxPayloadBytes);
    const pending = this.#pending.get(response.id);
    if (!pending || pending.targetId !== senderTargetId) return false;
    this.#settle(response.id);
    if (response.type === "result") {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new AppRendererRpcError("renderer-error", response.message, response.code),
      );
    }
    return true;
  }

  acceptContextCall(senderTargetId: number, candidate: unknown): boolean {
    const call = parseContextCall(candidate, this.#maxPayloadBytes);
    const pending = this.#pending.get(call.parentId);
    if (!pending || pending.targetId !== senderTargetId) return false;
    if (!pending.handleContextCall) {
      this.#sendContextError(
        senderTargetId,
        call,
        "CONTEXT_CALL_UNAVAILABLE",
        "This request does not expose App context calls.",
      );
      return true;
    }
    if (
      pending.seenContextCalls.has(call.id) ||
      pending.seenContextCalls.size >= MAX_TOTAL_CONTEXT_CALLS_PER_REQUEST ||
      pending.activeContextCalls.size >= MAX_CONTEXT_CALLS_PER_REQUEST
    ) {
      this.#sendContextError(
        senderTargetId,
        call,
        "CONTEXT_CALL_LIMIT",
        "This request has too many active or duplicate context calls.",
      );
      return true;
    }

    pending.seenContextCalls.add(call.id);
    pending.activeContextCalls.add(call.id);
    void Promise.resolve()
      .then(() =>
        pending.handleContextCall?.(
          call.method,
          call.input,
          pending.contextController.signal,
        ),
      )
      .then(
      (result) => {
        const current = this.#pending.get(call.parentId);
        if (current !== pending || !pending.activeContextCalls.delete(call.id)) return;
        try {
          assertPayloadSize(result, this.#maxPayloadBytes);
          this.#sendContextMessage(senderTargetId, {
            type: "context-result",
            parentId: call.parentId,
            id: call.id,
            result,
          });
        } catch (error) {
          this.#sendContextError(
            senderTargetId,
            call,
            "INVALID_CONTEXT_RESULT",
            toError(error).message,
          );
        }
      },
      (error) => {
        const current = this.#pending.get(call.parentId);
        if (current !== pending || !pending.activeContextCalls.delete(call.id)) return;
        const publicError = toPublicContextError(error);
        this.#sendContextError(
          senderTargetId,
          call,
          publicError.code,
          publicError.message,
        );
      },
    );
    return true;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const targetId of this.#targets.keys()) {
      this.#cancelTarget(targetId, "host-stopped", "App renderer RPC host stopped.");
    }
    this.#targets.clear();
  }

  #cancelRequest(id: string, reason: OperationCancellationCode, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    const target = this.#targets.get(pending.targetId);
    this.#settle(id);
    try {
      target?.send({ type: "cancel", id, reason });
    } finally {
      pending.reject(error);
    }
  }

  #cancelTarget(targetId: number, reason: OperationCancellationCode, message: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.targetId !== targetId) continue;
      this.#cancelRequest(
        id,
        reason,
        new AppRendererRpcError(
          reason === "host-stopped" ? "host-stopped" : "renderer-unavailable",
          message,
        ),
      );
    }
  }

  #settle(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.contextController.abort(new Error("Parent App request settled."));
    pending.activeContextCalls.clear();
    pending.seenContextCalls.clear();
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  #pendingCount(targetId: number): number {
    let count = 0;
    for (const pending of this.#pending.values()) {
      if (pending.targetId === targetId) count += 1;
    }
    return count;
  }

  #mintUniqueRequestId(): string {
    const id = this.#mintRequestId();
    if (typeof id !== "string" || id.length === 0 || id.length > 128 || this.#pending.has(id)) {
      throw new AppRendererRpcError("invalid-message", "RPC request ID generator returned an invalid ID.");
    }
    return id;
  }

  #sendContextError(
    targetId: number,
    call: Pick<AppRendererRpcContextCallMessage, "parentId" | "id">,
    code: string,
    message: string,
  ): void {
    this.#sendContextMessage(targetId, {
      type: "context-error",
      parentId: call.parentId,
      id: call.id,
      code: sanitizeErrorCode(code),
      message: message.slice(0, 2_048),
    });
  }

  #sendContextMessage(targetId: number, message: AppRendererRpcContextResponseMessage): void {
    try {
      this.#targets.get(targetId)?.send(message);
    } catch {
      // Renderer destruction races target-unregister events. The parent request
      // remains authoritative and will be cancelled when that event arrives.
    }
  }
}

function parseResponse(candidate: unknown, maxPayloadBytes: number): AppRendererRpcResponseMessage {
  if (!isRecord(candidate) || (candidate.type !== "result" && candidate.type !== "error")) {
    throw new AppRendererRpcError("invalid-message", "App renderer response is invalid.");
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 128) {
    throw new AppRendererRpcError("invalid-message", "App renderer response ID is invalid.");
  }
  if (candidate.type === "result") {
    assertPayloadSize(candidate.result, maxPayloadBytes);
    return { type: "result", id: candidate.id, result: candidate.result };
  }
  if (
    typeof candidate.code !== "string" ||
    candidate.code.length === 0 ||
    candidate.code.length > 128 ||
    typeof candidate.message !== "string" ||
    candidate.message.length > 2_048
  ) {
    throw new AppRendererRpcError("invalid-message", "App renderer error response is invalid.");
  }
  return { type: "error", id: candidate.id, code: candidate.code, message: candidate.message };
}

function parseContextCall(
  candidate: unknown,
  maxPayloadBytes: number,
): AppRendererRpcContextCallMessage {
  if (
    !isRecord(candidate) ||
    candidate.type !== "context-call" ||
    typeof candidate.parentId !== "string" ||
    candidate.parentId.length === 0 ||
    candidate.parentId.length > 128 ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.length > 128 ||
    typeof candidate.method !== "string" ||
    !APP_RENDERER_CONTEXT_METHODS.includes(candidate.method as AppRendererContextMethod)
  ) {
    throw new AppRendererRpcError("invalid-message", "App renderer context call is invalid.");
  }
  assertPayloadSize(candidate.input, maxPayloadBytes);
  return {
    type: "context-call",
    parentId: candidate.parentId,
    id: candidate.id,
    method: candidate.method as AppRendererContextMethod,
    input: candidate.input,
  };
}

function assertPayloadSize(value: unknown, maxPayloadBytes: number): void {
  assertJsonCompatible(value, new Set(), 0);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new AppRendererRpcError(
      "invalid-message",
      `App renderer payload must be JSON-serializable: ${toError(error).message}`,
    );
  }
  if (serialized === undefined) {
    throw new AppRendererRpcError("invalid-message", "App renderer payload must be JSON-serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxPayloadBytes) {
    throw new AppRendererRpcError("payload-too-large", "App renderer payload exceeds its limit.");
  }
}

function assertJsonCompatible(value: unknown, ancestors: Set<object>, depth: number): void {
  if (depth > 64) {
    throw new AppRendererRpcError("invalid-message", "App renderer payload is too deeply nested.");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new AppRendererRpcError(
      "invalid-message",
      "App renderer payload contains a non-JSON value.",
    );
  }
  if (ancestors.has(value)) {
    throw new AppRendererRpcError("invalid-message", "App renderer payload contains a cycle.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new AppRendererRpcError(
      "invalid-message",
      "App renderer payload contains a non-JSON object.",
    );
  }
  ancestors.add(value);
  try {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      assertJsonCompatible(child, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("App operation was cancelled.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toPublicContextError(error: unknown): { code: string; message: string } {
  if (isRecord(error) && typeof error.code === "string" && error instanceof Error) {
    return { code: sanitizeErrorCode(error.code), message: error.message.slice(0, 2_048) };
  }
  return { code: "CONTEXT_CALL_FAILED", message: toError(error).message.slice(0, 2_048) };
}

function sanitizeErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : "CONTEXT_CALL_FAILED";
}

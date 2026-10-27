// FILE: wsTransport.ts
// Purpose: Browser-side Effect RPC transport over the Penkra WebSocket endpoint.
// Layer: Web transport
// Exports: WsTransport plus stream-selection helpers used by tests.

import type { CleanCoreSidebarChange } from "@penkra/contracts";
import {
  CLEAN_CORE_WS_CHANNELS,
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_CHANNELS,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_SERVER_CAPABILITIES,
  WS_METHODS,
  WsBootstrapRpcGroup,
  WsCompatibilityError,
  WsFeatureRpcGroup,
  type GetProviderConnectionLoginInput,
  type ProviderConnectionLoginSnapshot,
  type ProjectWorkspaceChangeEvent,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProviderStatusesUpdatedPayload,
  type ServerSettingsUpdatedPayload,
  type ServerProviderUsageChange,
  type WsPush,
  type WsPushChannel,
  type WsPushMessage,
  type WsBootstrapNegotiateResult,
} from "@penkra/contracts";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime, Schema, Scope, Stream } from "effect";
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import { APP_VERSION } from "./branding";
import type { WsTransportState } from "./wsTransportEvents";

type PushListener<C extends WsPushChannel> = (message: WsPushMessage<C>) => void;

type RpcClientEffect = typeof makeRpcClient;
type RpcClientInstance =
  RpcClientEffect extends Effect.Effect<infer Client, any, any> ? Client : never;

class WsTransportRpcError extends Data.TaggedError("WsTransportRpcError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WsTransportRequestInterruptedError extends Data.TaggedError(
  "WsTransportRequestInterruptedError",
)<{
  readonly message: string;
  readonly code: "WS_REQUEST_TIMEOUT" | "WS_REQUEST_ABORTED";
  readonly method: string;
  readonly timeoutMs?: number;
  readonly cause?: unknown;
}> {}

export interface WsRequestOptions {
  readonly timeoutMs?: number | null;
  readonly signal?: AbortSignal;
  /** Retry the identical request after a transport reconnect. */
  readonly retryOnReconnect?: boolean;
}

interface RequestAbortScope {
  readonly signal: AbortSignal | undefined;
  readonly didTimeout: () => boolean;
  readonly cleanup: () => void;
}

export function makeRequestAbortScope(options?: WsRequestOptions): RequestAbortScope {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("WebSocket RPC timeoutMs must be a finite non-negative number or null.");
    }
  }
  if (timeoutMs === undefined || timeoutMs === null) {
    return {
      signal: options?.signal,
      didTimeout: () => false,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let cleanedUp = false;
  const externalSignal = options?.signal;
  const abortFromExternal = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timeoutId = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      globalThis.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

export function shouldReconnectAfterRequestFailure(error: unknown): boolean {
  if (Socket.SocketError.is(error)) return true;
  if (!Schema.is(RpcClientError.RpcClientError)(error)) return false;
  return (
    error.reason._tag === "SocketReadError" ||
    error.reason._tag === "SocketWriteError" ||
    error.reason._tag === "SocketOpenError" ||
    error.reason._tag === "SocketCloseError"
  );
}

function awaitWithAbort<A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const makeRpcClient = RpcClient.make(WsFeatureRpcGroup);
const makeBootstrapRpcClient = RpcClient.make(WsBootstrapRpcGroup);
const REQUEST_TIMEOUT_MS = 60_000;
export const WS_RECONNECT_ATTEMPT_TIMEOUT_MS = 3_000;

function resolveRpcUrl(rawUrl: string, path: string): string {
  const url = new URL(rawUrl);
  url.pathname = path;
  return url.toString();
}

function rawSocketUrl(explicitUrl: string | null): string {
  if (explicitUrl) return explicitUrl;
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  return bridgeUrl && bridgeUrl.length > 0
    ? bridgeUrl
    : envUrl && envUrl.length > 0
      ? envUrl
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
}

function makeSocketUrl(explicitUrl: string | null, path: string): string {
  return resolveRpcUrl(rawSocketUrl(explicitUrl), path);
}

export function makeFeatureSocketUrl(
  explicitUrl: string | null,
  compatibility: WsBootstrapNegotiateResult,
): string {
  const url = new URL(makeSocketUrl(explicitUrl, WS_FEATURE_PATH));
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, APP_VERSION);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(compatibility.protocolEpoch));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(compatibility.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, compatibility.serverInstanceId);
  return url.toString();
}

function makeProtocolLayer(url: string) {
  const socketLayer = Socket.layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  // JSON keeps the wire format symmetric with any server build: a serialization
  // mismatch on this single multiplexed socket is a hard connect failure, and the
  // desktop/dev setup routinely runs web and server on independently-built copies.
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  const error = Cause.squash(cause);
  return error instanceof Error ? error : new Error(String(error));
}

const STREAM_FAILURES_THAT_MUST_NOT_RECONNECT = new Set([
  "STREAM_CAPACITY_EXCEEDED",
  "THREAD_STREAM_CAPACITY_EXCEEDED",
  "THREAD_SNAPSHOT_NOT_FOUND",
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
]);
const TERMINAL_COMPATIBILITY_ERROR_CODES = new Set([
  "WS_NEGOTIATION_REQUIRED",
  "WS_PROTOCOL_INCOMPATIBLE",
  "WS_CAPABILITIES_INCOMPATIBLE",
]);

export function isTerminalCompatibilityFailure(error: unknown): boolean {
  return (
    (Schema.is(WsCompatibilityError)(error) && error.retryable === false) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      TERMINAL_COMPATIBILITY_ERROR_CODES.has(error.code))
  );
}

export function getTerminalCompatibilityError(error: unknown): WsCompatibilityError | null {
  return Schema.is(WsCompatibilityError)(error) && error.retryable === false ? error : null;
}

export function shouldReconnectAfterStreamFailure(cause: Cause.Cause<unknown>): boolean {
  return !cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? error.code : undefined;
    return typeof code === "string" && STREAM_FAILURES_THAT_MUST_NOT_RECONNECT.has(code);
  });
}

const RETRYABLE_STREAM_CAPACITY_ERROR_CODES = new Set([
  "STREAM_CAPACITY_EXCEEDED",
  "THREAD_STREAM_CAPACITY_EXCEEDED",
]);
const DEFAULT_STREAM_CAPACITY_RETRY_MS = 1_000;
const MAX_STREAM_CAPACITY_RETRY_MS = 10_000;

/**
 * Capacity rejections are admission failures the server marks retryable: the
 * budget frees up as soon as another lease releases, so the stream must be
 * retried in place rather than dropped or escalated to a socket reconnect.
 */
export function getStreamCapacityRetryDelayMs(cause: Cause.Cause<unknown>): number | null {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !RETRYABLE_STREAM_CAPACITY_ERROR_CODES.has(code)) continue;
    if ("retryable" in error && error.retryable === false) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_STREAM_CAPACITY_RETRY_MS;
  }
  return null;
}

const RETRYABLE_STREAM_DUPLICATE_ERROR_CODES = new Set([
  "STREAM_DUPLICATE_SUBSCRIPTION",
  "THREAD_STREAM_DUPLICATE_SUBSCRIPTION",
]);
const DEFAULT_STREAM_DUPLICATE_RETRY_MS = 250;
export const MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS = 5;
const THREAD_SNAPSHOT_BOOTSTRAP_ERROR_CODE = "THREAD_SNAPSHOT_NOT_FOUND";
const DEFAULT_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_MS = 100;
export const MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS = 12;

/**
 * Duplicate rejections arrive marked `retryable: false` because one socket may
 * not hold two leases for the same stream. A cancel→fast-resubscribe still
 * races the server-side lease release (the lease frees only when the server
 * stream scope closes), so a bounded in-place retry is required to let the
 * stale lease drain. If all bounded retries fail, the caller reconnects the
 * socket: a fresh client identity releases the orphaned lease and prevents the
 * thread stream from remaining permanently dead.
 */
export function getStreamDuplicateRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code !== "string" || !RETRYABLE_STREAM_DUPLICATE_ERROR_CODES.has(code)) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_STREAM_DUPLICATE_RETRY_MS;
  }
  return null;
}

/**
 * A visible local draft subscribes before its canonical thread row exists
 * so it cannot miss the first provider events. The event journal and projection
 * commit independently, leaving a short window where that valid subscription
 * receives THREAD_SNAPSHOT_NOT_FOUND. Retry only that admission race in place;
 * bounded attempts still surface genuinely missing or deleted thread ids.
 */
export function getThreadSnapshotBootstrapRetryDelayMs(
  cause: Cause.Cause<unknown>,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS) return null;
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (code !== THREAD_SNAPSHOT_BOOTSTRAP_ERROR_CODE) continue;
    const retryAfterMs = "retryAfterMs" in error ? error.retryAfterMs : undefined;
    return typeof retryAfterMs === "number" && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_MS;
  }
  return null;
}

export type StreamAdmissionRetry =
  | { readonly kind: "capacity"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "duplicate"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "thread-bootstrap"; readonly attempt: number; readonly delayMs: number };

export function resolveStreamAdmissionRetry(
  cause: Cause.Cause<unknown>,
  capacityAttempts: number,
  duplicateAttempts: number,
  threadBootstrapAttempts = 0,
): StreamAdmissionRetry | null {
  const capacityDelayMs = getStreamCapacityRetryDelayMs(cause);
  if (capacityDelayMs !== null) {
    return {
      kind: "capacity",
      attempt: capacityAttempts + 1,
      delayMs: capacityDelayMs,
    };
  }
  const duplicateDelayMs = getStreamDuplicateRetryDelayMs(cause, duplicateAttempts);
  if (duplicateDelayMs !== null) {
    return {
      kind: "duplicate",
      attempt: duplicateAttempts + 1,
      delayMs: duplicateDelayMs,
    };
  }
  const threadBootstrapDelayMs = getThreadSnapshotBootstrapRetryDelayMs(
    cause,
    threadBootstrapAttempts,
  );
  if (threadBootstrapDelayMs === null) return null;
  return {
    kind: "thread-bootstrap",
    attempt: threadBootstrapAttempts + 1,
    delayMs: threadBootstrapDelayMs,
  };
}

export function getStreamFailureCode(cause: Cause.Cause<unknown>): string | null {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!error || typeof error !== "object") continue;
    const code = "code" in error ? error.code : undefined;
    if (typeof code === "string") return code;
  }
  return null;
}

const THREAD_STREAM_KEY_PREFIX = "cleanCore.thread:";

function threadIdFromStreamKey(key: string): string | null {
  return key.startsWith(THREAD_STREAM_KEY_PREFIX)
    ? key.slice(THREAD_STREAM_KEY_PREFIX.length)
    : null;
}

export function threadStreamInputsEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([key, value]) => (right as Record<string, unknown>)[key] === value);
}

export interface WsThreadStreamFailure {
  readonly threadId: string;
  readonly code: string | null;
  readonly error: Error;
}

export function isServerLifecyclePushChannel(channel: string): boolean {
  return channel === WS_CHANNELS.serverWelcome || channel === WS_CHANNELS.serverMaintenanceUpdated;
}

export function shouldKeepServerLifecycleStream(activeChannels: ReadonlySet<string>): boolean {
  return (
    activeChannels.has(WS_CHANNELS.serverWelcome) ||
    activeChannels.has(WS_CHANNELS.serverMaintenanceUpdated)
  );
}

export function isServerConfigPushChannel(channel: string): boolean {
  return (
    channel === WS_CHANNELS.serverConfigUpdated || channel === WS_CHANNELS.providerCatalogChanged
  );
}

export function shouldKeepServerConfigStream(activeChannels: ReadonlySet<string>): boolean {
  return [...activeChannels].some(isServerConfigPushChannel);
}

export class WsTransport {
  subscribeRemoteDevices(onChange: () => void, onError: (error: Error) => void): () => void {
    let stopped = false,
      generation = 0;
    let cancel: (() => void) | undefined;
    const unsubscribe = this.onStateChange(
      (state) => {
        const current = ++generation;
        cancel?.();
        cancel = undefined;
        if (state !== "open") return;
        void this.getClient()
          .then((client) => {
            if (stopped || current !== generation || this.disposed) return;
            cancel = this.getClientRuntime(client).runCallback(
              Stream.runForEach(client[WS_METHODS.remoteSubscribeDevices]({}), () =>
                Effect.sync(() => {
                  if (!stopped && current === generation) onChange();
                }),
              ),
              {
                onExit: (exit) => {
                  if (
                    !stopped &&
                    current === generation &&
                    Exit.isFailure(exit) &&
                    !Cause.hasInterruptsOnly(exit.cause)
                  )
                    onError(causeToError(exit.cause));
                },
              },
            );
          })
          .catch((error) => {
            if (!stopped && current === generation)
              onError(error instanceof Error ? error : new Error(String(error)));
          });
      },
      { replayCurrent: true },
    );
    return () => {
      stopped = true;
      generation++;
      unsubscribe();
      cancel?.();
    };
  }

  subscribePairing(
    onRequest: (request: import("@penkra/contracts").RemotePairingRequest | null) => void,
    onError: (error: Error) => void,
  ): () => void {
    let stopped = false;
    let generation = 0;
    let cancel: (() => void) | undefined;
    const unsubscribe = this.onStateChange(
      (state) => {
        const current = ++generation;
        cancel?.();
        cancel = undefined;
        if (state !== "open") {
          onRequest(null);
          return;
        }
        void this.getClient()
          .then((client) => {
            if (stopped || current !== generation || this.disposed) return;
            cancel = this.getClientRuntime(client).runCallback(
              Stream.runForEach(client[WS_METHODS.remoteSubscribePairing]({}), (value) =>
                Effect.sync(() => {
                  if (!stopped && current === generation) onRequest(value.request);
                }),
              ),
              {
                onExit: (exit) => {
                  if (
                    !stopped &&
                    current === generation &&
                    Exit.isFailure(exit) &&
                    !Cause.hasInterruptsOnly(exit.cause)
                  )
                    onError(causeToError(exit.cause));
                },
              },
            );
          })
          .catch((error) => {
            if (!stopped && current === generation)
              onError(error instanceof Error ? error : new Error(String(error)));
          });
      },
      { replayCurrent: true },
    );
    return () => {
      stopped = true;
      generation++;
      unsubscribe();
      cancel?.();
    };
  }

  subscribeConnectionLogin(
    input: GetProviderConnectionLoginInput,
    onSnapshot: (snapshot: ProviderConnectionLoginSnapshot) => void,
    onError: (error: Error) => void,
  ): () => void {
    let stopped = false;
    let cancel: (() => void) | undefined;
    void this.getClient()
      .then((client) => {
        if (stopped || this.disposed) return;
        const registeredCancel = this.getClientRuntime(client).runCallback(
          Stream.runForEach(
            client[WS_METHODS.providerSubscribeConnectionLogin](input),
            (snapshot) =>
              Effect.sync(() => {
                if (!stopped) onSnapshot(snapshot);
              }),
          ),
          {
            onExit: (exit) => {
              if (!stopped && Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
                onError(causeToError(exit.cause));
            },
          },
        );
        cancel = registeredCancel;
        if (stopped) cancel();
      })
      .catch((error) => {
        if (!stopped) onError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      stopped = true;
      cancel?.();
    };
  }

  private readonly explicitUrl: string | null;
  private readonly listeners = new Map<string, Set<(message: WsPush) => void>>();
  private readonly stateListeners = new Set<(state: WsTransportState) => void>();
  private readonly compatibilityListeners = new Set<(issue: WsCompatibilityError | null) => void>();
  private readonly threadStreamFailureListeners = new Set<
    (failure: WsThreadStreamFailure) => void
  >();
  private readonly latestPushByChannel = new Map<string, WsPush>();
  private sequence = 0;
  private sessionVersion = 0;
  private state: WsTransportState = "connecting";
  private disposed = false;
  private readonly runtimeByClient = new WeakMap<
    RpcClientInstance,
    ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>
  >();
  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private clientScope: Scope.Closeable;
  private clientPromise: Promise<RpcClientInstance>;
  private reconnectPromise: Promise<RpcClientInstance> | null = null;
  private readonly activeRequests = new Map<object, Set<AbortController>>();
  private reconnectFailures = 0;
  private readonly streamCleanups = new Map<string, () => void>();
  private readonly streamSettled = new Map<string, Promise<void>>();
  private readonly streamCapacityRetries = new Map<string, number>();
  private readonly streamDuplicateRetries = new Map<string, number>();
  private readonly streamThreadBootstrapRetries = new Map<string, number>();
  private readonly streamCapacityRetryTimers = new Map<string, number>();
  private syncAppliedSequence: number | undefined;
  private readonly cleanCoreThreadSubscriptions = new Map<string, unknown>();
  private readonly activeCleanCoreThreadInputs = new Map<string, unknown>();
  private compatibility: WsBootstrapNegotiateResult | null = null;
  private compatibilityIssue: WsCompatibilityError | null = null;

  constructor(url?: string) {
    this.explicitUrl = url ?? null;
    const session = this.createSession();
    this.runtime = session.runtime;
    this.clientScope = session.clientScope;
    this.clientPromise = this.withConnectionAttemptTimeout(session.clientPromise);
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: WsRequestOptions,
  ): Promise<T> {
    if (this.disposed) throw new Error("Transport disposed");
    const requestSessionVersion = this.sessionVersion;
    const requestOptions: WsRequestOptions =
      options?.timeoutMs === undefined ? { ...options, timeoutMs: REQUEST_TIMEOUT_MS } : options;
    const abortScope = makeRequestAbortScope(requestOptions);
    try {
      let client = await awaitWithAbort(this.getClient(), abortScope.signal);
      if (method === WS_METHODS.cleanCoreSubscribeThread) {
        const threadId = (params as { threadId: string }).threadId;
        this.cleanCoreThreadSubscriptions.set(threadId, params);
        await this.startCleanCoreThreadStream(client, threadId, params as never);
        return undefined as T;
      }

      const rpcInput = params ?? {};
      while (true) {
        const call = (
          client as unknown as Record<
            string,
            (input: unknown) => Effect.Effect<unknown, WsTransportRpcError, never>
          >
        )[method];
        if (!call) throw new WsTransportRpcError({ message: `Unknown RPC method: ${method}` });
        const clientRuntime = this.getClientRuntime(client);
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(abortScope.signal?.reason);
        if (abortScope.signal?.aborted) forwardAbort();
        else abortScope.signal?.addEventListener("abort", forwardAbort, { once: true });
        const activeRequests = this.activeRequests.get(clientRuntime) ?? new Set<AbortController>();
        activeRequests.add(controller);
        this.activeRequests.set(clientRuntime, activeRequests);
        try {
          const result = await awaitWithAbort(
            clientRuntime.runPromise(call(rpcInput), { signal: controller.signal }),
            controller.signal,
          );
          return result as T;
        } catch (error) {
          // Only a caller with a recorded idempotent admission may request replay.
          if (
            requestOptions.retryOnReconnect !== true ||
            isTerminalCompatibilityFailure(error) ||
            !shouldReconnectAfterRequestFailure(error)
          ) {
            throw error;
          }
          console.warn("WebSocket RPC request failed before reconnect", {
            method,
            error,
          });
          client = await awaitWithAbort(this.reconnect(), abortScope.signal);
        } finally {
          abortScope.signal?.removeEventListener("abort", forwardAbort);
          activeRequests.delete(controller);
          if (activeRequests.size === 0) this.activeRequests.delete(clientRuntime);
        }
      }
    } catch (error) {
      if (abortScope.didTimeout()) {
        throw new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} timed out after ${requestOptions.timeoutMs}ms.`,
          code: "WS_REQUEST_TIMEOUT",
          method,
          ...(requestOptions.timeoutMs !== undefined && requestOptions.timeoutMs !== null
            ? { timeoutMs: requestOptions.timeoutMs }
            : {}),
          cause: error,
        });
      }
      if (requestOptions.signal?.aborted) {
        throw new WsTransportRequestInterruptedError({
          message: `WebSocket RPC ${method} was cancelled.`,
          code: "WS_REQUEST_ABORTED",
          method,
          cause: requestOptions.signal.reason ?? error,
        });
      }
      throw error;
    } finally {
      abortScope.cleanup();
    }
  }

  subscribe<C extends WsPushChannel>(
    channel: C,
    listener: PushListener<C>,
    options?: { readonly replayLatest?: boolean },
  ): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set<(message: WsPush) => void>();
      this.listeners.set(channel, channelListeners);
      this.startChannelStream(channel);
    }

    const wrappedListener = (message: WsPush) => listener(message as WsPushMessage<C>);
    channelListeners.add(wrappedListener);

    if (options?.replayLatest) {
      const latest = this.latestPushByChannel.get(channel);
      if (latest) wrappedListener(latest);
    }

    return () => {
      channelListeners?.delete(wrappedListener);
      if (channelListeners?.size === 0) {
        this.listeners.delete(channel);
        this.stopChannelStream(channel);
      }
    };
  }

  getLatestPush<C extends WsPushChannel>(channel: C): WsPushMessage<C> | null {
    const latest = this.latestPushByChannel.get(channel);
    return latest ? (latest as WsPushMessage<C>) : null;
  }

  onStateChange(
    listener: (state: WsTransportState) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.stateListeners.add(listener);
    if (options?.replayCurrent) {
      listener(this.state);
    }

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): WsTransportState {
    return this.state;
  }

  getCompatibility(): WsBootstrapNegotiateResult | null {
    return this.compatibility;
  }

  onCompatibilityIssue(
    listener: (issue: WsCompatibilityError | null) => void,
    options?: { readonly replayCurrent?: boolean },
  ): () => void {
    this.compatibilityListeners.add(listener);
    if (options?.replayCurrent) listener(this.compatibilityIssue);
    return () => {
      this.compatibilityListeners.delete(listener);
    };
  }

  /** Fires when a per-thread stream dies with no retry or reconnect left. */
  onThreadStreamFailure(listener: (failure: WsThreadStreamFailure) => void): () => void {
    this.threadStreamFailureListeners.add(listener);
    return () => {
      this.threadStreamFailureListeners.delete(listener);
    };
  }

  private emitThreadStreamFailure(failure: WsThreadStreamFailure): void {
    for (const listener of this.threadStreamFailureListeners) {
      try {
        listener(failure);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.setState("disposed");
    this.resetAllStreamCapacityRetries();
    for (const cleanup of this.streamCleanups.values()) cleanup();
    this.streamCleanups.clear();
    this.threadStreamFailureListeners.clear();
    // Dispose can race with initial connection or reconnect promises. Mark them
    // handled before closing the runtime so test/browser teardown stays quiet.
    void this.clientPromise.catch(() => undefined);
    void this.reconnectPromise?.catch(() => undefined);
    const runtime = this.runtime;
    const clientScope = this.clientScope;
    await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
    await runtime.dispose().catch(() => undefined);
  }

  private createSession() {
    const sessionVersion = ++this.sessionVersion;
    const runtime = ManagedRuntime.make(
      makeProtocolLayer(makeSocketUrl(this.explicitUrl, WS_BOOTSTRAP_PATH)),
    );
    const clientScope = runtime.runSync(Scope.make());
    const clientPromise = (async () => {
      let compatibility: WsBootstrapNegotiateResult;
      try {
        const bootstrapClient = await runtime.runPromise(
          Scope.provide(clientScope)(makeBootstrapRpcClient),
        );
        compatibility = await runtime.runPromise(
          bootstrapClient[WS_BOOTSTRAP_METHOD]({
            protocolEpoch: WS_PROTOCOL_EPOCH,
            minRevision: WS_PROTOCOL_MIN_REVISION,
            maxRevision: WS_PROTOCOL_MAX_REVISION,
            clientBuild: APP_VERSION,
            requiredCapabilities: [...WS_SERVER_CAPABILITIES],
          }),
        );
      } finally {
        await runtime.runPromise(Scope.close(clientScope, Exit.void)).catch(() => undefined);
        await runtime.dispose().catch(() => undefined);
      }
      if (this.disposed || this.sessionVersion !== sessionVersion) {
        throw new Error("WebSocket session superseded during compatibility negotiation.");
      }

      const featureRuntime = ManagedRuntime.make(
        makeProtocolLayer(makeFeatureSocketUrl(this.explicitUrl, compatibility)),
      );
      const featureScope = featureRuntime.runSync(Scope.make());
      this.runtime = featureRuntime;
      this.clientScope = featureScope;
      const client = await featureRuntime.runPromise(Scope.provide(featureScope)(makeRpcClient));
      this.runtimeByClient.set(client, featureRuntime);
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        if (
          this.compatibility &&
          this.compatibility.serverInstanceId !== compatibility.serverInstanceId
        ) {
          this.latestPushByChannel.clear();
          this.sequence = 0;
        }
        this.compatibility = compatibility;
        this.setCompatibilityIssue(null);
        this.setState("open");
      }
      return client;
    })().catch((error) => {
      if (!this.disposed && this.sessionVersion === sessionVersion) {
        this.compatibility = null;
        const compatibilityError = getTerminalCompatibilityError(error);
        if (compatibilityError) {
          this.setCompatibilityIssue(compatibilityError);
          this.setState("incompatible");
        } else {
          this.setState("closed");
        }
      }
      throw error;
    });
    return { runtime, clientScope, clientPromise };
  }

  private async withConnectionAttemptTimeout(
    clientPromise: Promise<RpcClientInstance>,
  ): Promise<RpcClientInstance> {
    let timeoutId: number | undefined;
    // Closing a timed-out scope can settle the raw client promise later. The
    // bounded attempt owns that settlement so it never becomes unhandled.
    void clientPromise.catch(() => undefined);
    try {
      const client = await Promise.race([
        clientPromise,
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error("WebSocket connection attempt timed out."));
          }, WS_RECONNECT_ATTEMPT_TIMEOUT_MS);
        }),
      ]);
      return client;
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }

  private async getClient(): Promise<RpcClientInstance> {
    // Reconnect retires the current runtime before the replacement session is
    // ready. Requests arriving in that window must join the replacement instead
    // of receiving the resolved clientPromise for the disposed runtime.
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }
    try {
      return await this.clientPromise;
    } catch (error) {
      if (this.disposed) throw new Error("Transport disposed");
      if (isTerminalCompatibilityFailure(error)) throw error;
      return this.reconnect();
    }
  }

  private getClientRuntime(
    client: RpcClientInstance,
  ): ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> {
    const runtime = this.runtimeByClient.get(client);
    if (!runtime) {
      throw new Error("Missing runtime for WebSocket RPC client");
    }
    return runtime;
  }

  private reconnect(): Promise<RpcClientInstance> {
    if (this.reconnectPromise) return this.reconnectPromise;
    const oldRuntime = this.runtime;
    const oldClientScope = this.clientScope;

    // Publish the replacement promise before cancelling streams or notifying
    // state listeners: either can synchronously re-enter reconnect(). Retire
    // stream ownership before invoking cancellations so their exit callbacks
    // cannot independently replace this session.
    const reconnect = Promise.resolve().then(async () => {
      this.resetAllStreamCapacityRetries();
      const cleanups = [...this.streamCleanups.values()];
      this.streamCleanups.clear();
      this.setState("connecting");
      for (const cleanup of cleanups) cleanup();
      await oldRuntime.runPromise(Scope.close(oldClientScope, Exit.void)).catch(() => undefined);
      await oldRuntime.dispose().catch(() => undefined);
      return this.openReconnectSession();
    });
    const trackedReconnect = reconnect.finally(() => {
      if (this.reconnectPromise === trackedReconnect) {
        this.reconnectPromise = null;
      }
    });
    // A reconnect triggered by a stream exit during teardown rejects with
    // "Transport disposed"; every live caller also attaches its own handler, and
    // this keeps the shared promise from surfacing as an unhandled rejection.
    void trackedReconnect.catch(() => undefined);
    this.reconnectPromise = trackedReconnect;

    return trackedReconnect;
  }

  private setState(state: WsTransportState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // Listener errors must not break reconnect or RPC state transitions.
      }
    }
  }

  private clearStreamCapacityRetryTimer(key: string): void {
    const timeoutId = this.streamCapacityRetryTimers.get(key);
    if (timeoutId === undefined) return;
    window.clearTimeout(timeoutId);
    this.streamCapacityRetryTimers.delete(key);
  }

  private resetStreamCapacityRetry(key: string): void {
    this.clearStreamCapacityRetryTimer(key);
    this.streamCapacityRetries.delete(key);
    this.streamDuplicateRetries.delete(key);
    this.streamThreadBootstrapRetries.delete(key);
  }

  private resetAllStreamCapacityRetries(): void {
    for (const timeoutId of this.streamCapacityRetryTimers.values()) {
      window.clearTimeout(timeoutId);
    }
    this.streamCapacityRetryTimers.clear();
    this.streamCapacityRetries.clear();
    this.streamDuplicateRetries.clear();
    this.streamThreadBootstrapRetries.clear();
  }

  private setCompatibilityIssue(issue: WsCompatibilityError | null): void {
    if (this.compatibilityIssue === issue) return;
    this.compatibilityIssue = issue;
    for (const listener of this.compatibilityListeners) {
      try {
        listener(issue);
      } catch {
        // Compatibility UI listeners must not break transport teardown.
      }
    }
  }

  private async openReconnectSession(): Promise<RpcClientInstance> {
    while (!this.disposed) {
      const delayMs = Math.min(500 * 2 ** this.reconnectFailures, 5_000);
      this.reconnectFailures += 1;
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      if (this.disposed) break;

      this.setState("connecting");
      const session = this.createSession();
      this.runtime = session.runtime;
      this.clientScope = session.clientScope;
      this.clientPromise = this.withConnectionAttemptTimeout(session.clientPromise);

      try {
        // A WebSocket open can remain pending across an embedded-backend restart.
        // Bound each individual attempt so one half-open socket cannot become the
        // permanent reconnectPromise joined by every later command.
        const client = await this.clientPromise;
        this.reconnectFailures = 0;
        for (const channel of this.listeners.keys()) {
          this.startChannelStream(channel as WsPushChannel);
        }
        for (const [threadId, input] of this.cleanCoreThreadSubscriptions) {
          await this.startCleanCoreThreadStream(client, threadId, input);
        }
        return client;
      } catch (error) {
        if (isTerminalCompatibilityFailure(error)) throw error;
        // Closing the failed attempt also makes its client promise settle. Mark
        // it handled because the reconnect loop, not an individual attempt,
        // owns recovery.
        const failedRuntime = this.runtime;
        const failedScope = this.clientScope;
        await failedRuntime.runPromise(Scope.close(failedScope, Exit.void)).catch(() => undefined);
        await failedRuntime.dispose().catch(() => undefined);
      }
    }
    throw new Error("Transport disposed");
  }

  private emit<C extends WsPushChannel>(channel: C, data: WsPushMessage<C>["data"]): void {
    const message = {
      type: "push" as const,
      sequence: ++this.sequence,
      channel,
      data,
    } as WsPush;
    this.latestPushByChannel.set(channel, message);
    const listeners = this.listeners.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Listener errors must not break transport streams.
      }
    }
  }

  private startChannelStream(channel: WsPushChannel): void {
    void this.getClient()
      .then((client) => {
        const restartChannel = () => {
          if (this.listeners.has(channel)) {
            this.startChannelStream(channel);
          }
        };

        if (channel === CLEAN_CORE_WS_CHANNELS.sidebarChange) {
          this.startStream(
            client,
            "cleanCore.sidebar",
            client[WS_METHODS.cleanCoreSubscribeSidebar]({}),
            (change: CleanCoreSidebarChange) =>
              this.emit(CLEAN_CORE_WS_CHANNELS.sidebarChange, change),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverProviderUsageUpdated) {
          this.startStream(
            client,
            "server.providerUsage",
            client[WS_METHODS.serverSubscribeProviderUsage]({}),
            (change: ServerProviderUsageChange) =>
              this.emit(WS_CHANNELS.serverProviderUsageUpdated, change),
            restartChannel,
          );
        } else if (isServerLifecyclePushChannel(channel)) {
          this.startLifecycleStream(client);
        } else if (isServerConfigPushChannel(channel)) {
          this.startConfigStream(client);
        } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated) {
          this.startStream(
            client,
            "server.providers",
            client[WS_METHODS.subscribeServerProviderStatuses]({}),
            (payload: ServerProviderStatusesUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverProviderStatusesUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.serverSettingsUpdated) {
          this.startStream(
            client,
            "server.settings",
            client[WS_METHODS.subscribeServerSettings]({}),
            (payload: ServerSettingsUpdatedPayload) =>
              this.emit(WS_CHANNELS.serverSettingsUpdated, payload),
            restartChannel,
          );
        } else if (channel === WS_CHANNELS.projectWorkspaceChange) {
          this.startStream(
            client,
            "project.workspaceChanges",
            client[WS_METHODS.subscribeProjectWorkspaceChanges]({}),
            (event: ProjectWorkspaceChangeEvent) =>
              this.emit(WS_CHANNELS.projectWorkspaceChange, event),
            restartChannel,
          );
        }
      })
      .catch((error) => {
        if (
          !this.disposed &&
          this.listeners.has(channel) &&
          !isTerminalCompatibilityFailure(error)
        ) {
          console.warn("WebSocket RPC channel failed to start", error);
          window.setTimeout(() => this.startChannelStream(channel), 500);
        }
      });
  }

  private stopChannelStream(channel: WsPushChannel): void {
    if (isServerLifecyclePushChannel(channel)) {
      if (!this.shouldKeepLifecycleStream()) this.stopStream("server.lifecycle");
    } else if (isServerConfigPushChannel(channel)) {
      if (!shouldKeepServerConfigStream(new Set(this.listeners.keys())))
        this.stopStream("server.config");
    } else if (channel === WS_CHANNELS.serverProviderStatusesUpdated)
      this.stopStream("server.providers");
    else if (channel === WS_CHANNELS.serverProviderUsageUpdated)
      this.stopStream("server.providerUsage");
    else if (channel === WS_CHANNELS.serverSettingsUpdated) this.stopStream("server.settings");
    else if (channel === WS_CHANNELS.projectWorkspaceChange)
      this.stopStream("project.workspaceChanges");
  }

  private shouldKeepLifecycleStream(): boolean {
    return shouldKeepServerLifecycleStream(new Set(this.listeners.keys()));
  }

  private startConfigStream(client: RpcClientInstance): void {
    const restart = () => {
      if (!shouldKeepServerConfigStream(new Set(this.listeners.keys()))) return;
      void this.getClient()
        .then((next) => this.startConfigStream(next))
        .catch((error) => {
          console.warn("WebSocket RPC config stream failed to restart", error);
        });
    };
    this.startStream(
      client,
      "server.config",
      client[WS_METHODS.subscribeServerConfig]({}),
      (event: ServerConfigStreamEvent) => {
        if (event.type === "snapshot")
          this.emit(WS_CHANNELS.serverConfigUpdated, { providers: event.config.providers });
        else if (event.type === "catalog.changed")
          this.emit(WS_CHANNELS.providerCatalogChanged, {
            _tag: "catalog.changed",
            scope: event.scope,
            version: event.version,
          });
      },
      restart,
    );
  }

  private startLifecycleStream(client: RpcClientInstance): void {
    const restartLifecycle = () => {
      if (!this.shouldKeepLifecycleStream()) return;
      void this.getClient()
        .then((nextClient) => this.startLifecycleStream(nextClient))
        .catch((error) => {
          console.warn("WebSocket RPC lifecycle stream failed to restart", error);
        });
    };
    this.startStream(
      client,
      "server.lifecycle",
      client[WS_METHODS.subscribeServerLifecycle]({}),
      (event: ServerLifecycleStreamEvent) => {
        if (event.type === "welcome") {
          this.emit(WS_CHANNELS.serverWelcome, event.payload);
        } else if (event.type === "maintenance") {
          this.emit(WS_CHANNELS.serverMaintenanceUpdated, event);
        }
      },
      restartLifecycle,
    );
  }

  /** Stop the clean-core change subscription for one thread (client-owned stream). */
  stopCleanCoreThreadStream(threadId: string): void {
    this.cleanCoreThreadSubscriptions.delete(threadId);
    const key = `cleanCore.thread:${threadId}`;
    this.activeCleanCoreThreadInputs.delete(key);
    void this.stopStream(key, { resetCapacityRetry: false }).catch(() => undefined);
  }

  private async startCleanCoreThreadStream(
    client: RpcClientInstance,
    threadId: string,
    input: unknown,
  ): Promise<void> {
    const key = `cleanCore.thread:${threadId}`;
    if (this.disposed || this.cleanCoreThreadSubscriptions.get(threadId) !== input) {
      return;
    }
    if (this.streamCleanups.has(key) && this.activeCleanCoreThreadInputs.get(key) === input) {
      return;
    }
    const sessionVersion = this.sessionVersion;
    await this.stopStream(key, { resetCapacityRetry: false });
    if (
      this.disposed ||
      this.sessionVersion !== sessionVersion ||
      this.cleanCoreThreadSubscriptions.get(threadId) !== input
    ) {
      return;
    }
    const restart = () => {
      const desired = this.cleanCoreThreadSubscriptions.get(threadId);
      if (desired === undefined) return;
      void this.getClient()
        .then((nextClient) => this.startCleanCoreThreadStream(nextClient, threadId, desired))
        .catch((error) => {
          console.warn("WebSocket RPC clean-core thread stream failed to restart", error);
        });
    };
    this.activeCleanCoreThreadInputs.set(key, input);
    this.startStream(
      client,
      key,
      (client as unknown as Record<string, (i: unknown) => unknown>)[
        WS_METHODS.cleanCoreSubscribeThread
      ]!(input),
      (change: { readonly threadId: string }) =>
        this.emit(CLEAN_CORE_WS_CHANNELS.threadChange, change as never),
      restart,
    );
  }

  private startStream<T>(
    client: RpcClientInstance,
    key: string,
    stream: unknown,
    listener: (event: T) => void,
    restart?: (() => void) | undefined,
  ): void {
    if (this.streamCleanups.has(key)) return;
    this.clearStreamCapacityRetryTimer(key);
    const runnableStream = stream as Stream.Stream<T, WsTransportRpcError, never>;
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let cancel: (() => void) | undefined;
    let exitedSynchronously = false;
    const registeredCancel = this.getClientRuntime(client).runCallback(
      Stream.runForEach(runnableStream, (event) =>
        Effect.sync(() => {
          if (this.streamCapacityRetries.has(key)) {
            this.streamCapacityRetries.delete(key);
          }
          if (this.streamDuplicateRetries.has(key)) {
            this.streamDuplicateRetries.delete(key);
          }
          if (this.streamThreadBootstrapRetries.has(key)) {
            this.streamThreadBootstrapRetries.delete(key);
          }
          listener(event);
        }),
      ),
      {
        onExit: (exit) => {
          if (this.streamSettled.get(key) === settled) {
            this.streamSettled.delete(key);
          }
          resolveSettled();
          if (cancel === undefined) {
            exitedSynchronously = true;
            return;
          }
          const wasReplacedOrStopped = this.streamCleanups.get(key) !== cancel;
          if (!wasReplacedOrStopped) {
            this.streamCleanups.delete(key);
          }
          if (wasReplacedOrStopped || this.disposed) {
            return;
          }
          // Subscription streams are intentionally unbounded. A clean completion is therefore
          // a dropped connection, not success. Retire the whole session before
          // recreating any streams: the resolved RPC client belongs to the socket
          // that just closed and cannot safely service later commands. Reconnect
          // synchronously so it clears the other stream owners before their exit
          // callbacks can each schedule a stale reconnect against the replacement
          // session. openReconnectSession restores every declared subscription.
          if (restart && Exit.isSuccess(exit)) {
            void this.reconnect().catch((error) => {
              if (!this.disposed) {
                console.warn("WebSocket RPC stream reconnect failed", error);
              }
            });
            return;
          }
          if (restart && Exit.isFailure(exit)) {
            const admissionRetry = resolveStreamAdmissionRetry(
              exit.cause,
              this.streamCapacityRetries.get(key) ?? 0,
              this.streamDuplicateRetries.get(key) ?? 0,
              this.streamThreadBootstrapRetries.get(key) ?? 0,
            );
            if (admissionRetry !== null) {
              const retries =
                admissionRetry.kind === "capacity"
                  ? this.streamCapacityRetries
                  : admissionRetry.kind === "duplicate"
                    ? this.streamDuplicateRetries
                    : this.streamThreadBootstrapRetries;
              retries.set(key, admissionRetry.attempt);
              this.clearStreamCapacityRetryTimer(key);
              const timeoutId = window.setTimeout(
                () => {
                  if (this.streamCapacityRetryTimers.get(key) !== timeoutId) return;
                  this.streamCapacityRetryTimers.delete(key);
                  if (!this.disposed && !this.streamCleanups.has(key)) {
                    restart();
                  }
                },
                Math.min(
                  admissionRetry.delayMs * admissionRetry.attempt,
                  MAX_STREAM_CAPACITY_RETRY_MS,
                ),
              );
              this.streamCapacityRetryTimers.set(key, timeoutId);
              return;
            }
          }
          if (restart && Exit.isFailure(exit) && shouldReconnectAfterStreamFailure(exit.cause)) {
            void this.reconnect().catch((error) => {
              if (!this.disposed) {
                console.warn("WebSocket RPC stream reconnect failed", error);
              }
            });
            return;
          }
          if (Exit.isFailure(exit) && !this.disposed && !Cause.hasInterruptsOnly(exit.cause)) {
            const error = causeToError(exit.cause);
            console.warn("WebSocket RPC stream failed", error);
            const threadId = threadIdFromStreamKey(key);
            if (threadId !== null && this.cleanCoreThreadSubscriptions.has(threadId)) {
              this.emitThreadStreamFailure({
                threadId,
                code: getStreamFailureCode(exit.cause),
                error,
              });
            }
          }
        },
      },
    );
    cancel = registeredCancel;
    if (exitedSynchronously) return;
    this.streamCleanups.set(key, cancel);
    this.streamSettled.set(key, settled);
  }

  private stopStream(
    key: string,
    options?: { readonly resetCapacityRetry?: boolean },
  ): Promise<void> {
    this.clearStreamCapacityRetryTimer(key);
    if (options?.resetCapacityRetry !== false) {
      this.streamCapacityRetries.delete(key);
      this.streamDuplicateRetries.delete(key);
      this.streamThreadBootstrapRetries.delete(key);
    }
    const cleanup = this.streamCleanups.get(key);
    const settled = this.streamSettled.get(key) ?? Promise.resolve();
    if (!cleanup) return settled;
    this.streamCleanups.delete(key);
    cleanup();
    return settled;
  }
}

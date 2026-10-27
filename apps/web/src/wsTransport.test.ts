// FILE: wsTransport.test.ts
// Purpose: Verifies browser WebSocket construction around the Effect RPC transport.
// Layer: Web transport tests
// Depends on: the global WebSocket constructor shim and desktop bridge URL contract.

import { Cause, Effect, Exit, Scope, Queue, Stream } from "effect";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLEAN_CORE_WS_CHANNELS,
  WS_METHODS,
  WS_CHANNELS,
  WS_COMPATIBILITY_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WsCompatibilityError,
  WsRpcError,
} from "@penkra/contracts";

import {
  shouldKeepServerLifecycleStream,
  shouldKeepServerConfigStream,
  getStreamCapacityRetryDelayMs,
  getStreamDuplicateRetryDelayMs,
  getStreamFailureCode,
  getThreadSnapshotBootstrapRetryDelayMs,
  getTerminalCompatibilityError,
  isTerminalCompatibilityFailure,
  makeFeatureSocketUrl,
  makeRequestAbortScope,
  MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS,
  MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
  resolveStreamAdmissionRetry,
  shouldReconnectAfterRequestFailure,
  shouldReconnectAfterStreamFailure,
  threadStreamInputsEqual,
  WsTransport,
  WS_RECONNECT_ATTEMPT_TIMEOUT_MS,
  type WsThreadStreamFailure,
} from "./wsTransport";
import {
  addWsCompatibilityIssueListener,
  emitWsCompatibilityIssue,
  readLatestWsCompatibilityIssue,
} from "./wsTransportEvents";

type WsEventType = "open" | "message" | "close" | "error";
type WsListener = (event?: { data?: unknown }) => void;

const sockets: MockWebSocket[] = [];
let socketCreated: Promise<MockWebSocket>;
let resolveSocketCreated: (socket: MockWebSocket) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(readonly url: string) {
    sockets.push(this);
    resolveSocketCreated(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: WsEventType, event?: { data?: unknown }) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

/** State-machine tests own a controlled connection instead of leaking a real handshake. */
function makeControlledTransport(clientPromise: Promise<unknown> = Promise.resolve({})) {
  const createSession = vi
    .spyOn(WsTransport.prototype as unknown as { createSession: () => unknown }, "createSession")
    .mockReturnValue({
      runtime: {
        runPromise: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
      },
      clientScope: Effect.runSync(Scope.make()),
      clientPromise,
    });
  try {
    return new WsTransport();
  } finally {
    createSession.mockRestore();
  }
}

interface WsTransportInternals {
  syncAppliedSequence: number | undefined;
  syncDeliveryId: string | undefined;
  readonly listeners: Map<string, Set<(message: unknown) => void>>;
  readonly failedPushListeners: WeakSet<(message: unknown) => void>;
  readonly latestPushByChannel: Map<string, unknown>;
  readonly streamCleanups: Map<string, () => void>;
  readonly streamSettled: Map<string, Promise<void>>;
  readonly streamCapacityRetries: Map<string, number>;
  readonly streamDuplicateRetries: Map<string, number>;
  readonly streamThreadBootstrapRetries: Map<string, number>;
  readonly streamCapacityRetryTimers: Map<string, number>;
  readonly activeThreadStreamInputs: Map<string, unknown>;
  readonly threadSubscriptions: Map<string, unknown>;
  readonly cleanCoreThreadSubscriptions: Map<string, unknown>;
  readonly activeCleanCoreThreadInputs: Map<string, unknown>;
  readonly threadStreamFailureListeners: Set<(failure: WsThreadStreamFailure) => void>;
  startThreadStream(
    client: unknown,
    threadId: string,
    input: unknown,
    forceRestart?: boolean,
  ): Promise<void>;
  startCleanCoreThreadStream(client: unknown, threadId: string, input: unknown): Promise<void>;
  stopStream(key: string, options?: { readonly resetCapacityRetry?: boolean }): Promise<void>;
  startStream(...args: unknown[]): void;
  startChannelStream(channel: string): void;
  stopChannelStream(channel: string): void;
  emitThreadStreamFailure(failure: WsThreadStreamFailure): void;
  emit(channel: string, data: unknown): void;
}

function makeBareTransport(): {
  readonly transport: WsTransport;
  readonly internals: WsTransportInternals;
} {
  const transport = Object.create(WsTransport.prototype) as WsTransport;
  const internals = transport as unknown as WsTransportInternals;
  Object.assign(internals, {
    streamCleanups: new Map(),
    streamSettled: new Map(),
    streamCapacityRetries: new Map(),
    streamDuplicateRetries: new Map(),
    streamThreadBootstrapRetries: new Map(),
    streamCapacityRetryTimers: new Map(),
    activeThreadStreamInputs: new Map(),
    threadSubscriptions: new Map(),
    cleanCoreThreadSubscriptions: new Map(),
    activeCleanCoreThreadInputs: new Map(),
    threadStreamFailureListeners: new Set(),
    listeners: new Map(),
    failedPushListeners: new WeakSet(),
    latestPushByChannel: new Map(),
  });
  return { transport, internals };
}

it("opens one provider-usage subscription channel and tears it down by its stream key", async () => {
  const { internals } = makeBareTransport();
  const stream = {};
  const subscribe = vi.fn(() => stream);
  const emit = vi.fn();
  const stopStream = vi.fn();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const change = { connectionId: "account", snapshot: { source: "test" } };
  const startStream = vi.fn(
    (
      _client: unknown,
      key: string,
      receivedStream: unknown,
      onValue: (change: unknown) => void,
    ) => {
      expect(key).toBe("server.providerUsage");
      expect(receivedStream).toBe(stream);
      onValue(change);
      resolveStarted();
    },
  );
  Object.assign(internals, {
    getClient: () => Promise.resolve({ [WS_METHODS.serverSubscribeProviderUsage]: subscribe }),
    startStream,
    stopStream,
    emit,
  });
  internals.startChannelStream(WS_CHANNELS.serverProviderUsageUpdated);
  await started;
  expect(subscribe).toHaveBeenCalledExactlyOnceWith({});
  expect(emit).toHaveBeenCalledWith(WS_CHANNELS.serverProviderUsageUpdated, change);
  internals.stopChannelStream(WS_CHANNELS.serverProviderUsageUpdated);
  expect(stopStream).toHaveBeenCalledWith("server.providerUsage");
});

beforeEach(() => {
  sockets.length = 0;
  socketCreated = new Promise((resolve) => {
    resolveSocketCreated = resolve;
  });
  vi.stubEnv("VITE_WS_URL", "");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", hostname: "localhost", port: "3020" },
      desktopBridge: undefined,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("WsTransport", () => {
  it("returns an unexpected final RPC failure without reconnecting", async () => {
    const transport = makeControlledTransport();
    const method = WS_METHODS.cleanCoreSendMessage;
    const client = { [method]: vi.fn(() => ({})) };
    const failure = new Error("unexpected transport failure");
    const runtime = { runPromise: vi.fn().mockRejectedValue(failure) };
    const internals = transport as unknown as {
      getClient: () => Promise<typeof client>;
      getClientRuntime: () => typeof runtime;
      reconnect: () => Promise<typeof client>;
    };
    internals.getClient = vi.fn().mockResolvedValue(client);
    internals.getClientRuntime = vi.fn(() => runtime);
    internals.reconnect = vi.fn();
    await expect(transport.request(method, {}, { timeoutMs: null })).rejects.toBe(failure);
    expect(internals.reconnect).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it("does not reconnect the socket for typed stream-admission failures", () => {
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({
          code: "STREAM_CAPACITY_EXCEEDED",
          retryable: true,
          retryAfterMs: 1_000,
        }),
      ),
    ).toBe(false);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "STREAM_DUPLICATE_SUBSCRIPTION", retryable: false }),
      ),
    ).toBe(true);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "THREAD_SNAPSHOT_NOT_FOUND", retryable: false }),
      ),
    ).toBe(false);
    expect(shouldReconnectAfterStreamFailure(Cause.fail(new Error("transient")))).toBe(true);
    expect(
      shouldReconnectAfterStreamFailure(
        Cause.fail({ code: "WS_PROTOCOL_INCOMPATIBLE", retryable: false }),
      ),
    ).toBe(false);
    expect(
      isTerminalCompatibilityFailure({
        code: "WS_PROTOCOL_INCOMPATIBLE",
        retryable: false,
      }),
    ).toBe(true);
  });

  it("retries capacity-rejected streams in place with the server-provided delay", () => {
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({
          code: "THREAD_STREAM_CAPACITY_EXCEEDED",
          retryable: true,
          retryAfterMs: 1_000,
        }),
      ),
    ).toBe(1_000);
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "STREAM_CAPACITY_EXCEEDED", retryable: true }),
      ),
    ).toBe(1_000);
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "STREAM_DUPLICATE_SUBSCRIPTION", retryable: false }),
      ),
    ).toBeNull();
    expect(getStreamCapacityRetryDelayMs(Cause.fail(new Error("transient")))).toBeNull();
    expect(
      getStreamCapacityRetryDelayMs(
        Cause.fail({ code: "WS_PROTOCOL_INCOMPATIBLE", retryable: false }),
      ),
    ).toBeNull();
  });

  it("retries duplicate-rejected streams in place despite the non-retryable marker", () => {
    const duplicate = Cause.fail({
      code: "STREAM_DUPLICATE_SUBSCRIPTION",
      retryable: false,
    });

    expect(getStreamDuplicateRetryDelayMs(duplicate, 0)).toBe(250);
    expect(
      getStreamDuplicateRetryDelayMs(
        Cause.fail({
          code: "THREAD_STREAM_DUPLICATE_SUBSCRIPTION",
          retryable: false,
          retryAfterMs: 400,
        }),
        1,
      ),
    ).toBe(400);
    expect(
      getStreamDuplicateRetryDelayMs(duplicate, MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS),
    ).toBeNull();
    expect(
      getStreamDuplicateRetryDelayMs(
        Cause.fail({ code: "STREAM_CAPACITY_EXCEEDED", retryable: true }),
        0,
      ),
    ).toBeNull();
    expect(getStreamDuplicateRetryDelayMs(Cause.fail(new Error("transient")), 0)).toBeNull();
  });

  it("keeps duplicate retry admission independent from prior capacity retries", () => {
    const capacity = Cause.fail({
      code: "STREAM_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 1_000,
    });
    const duplicate = Cause.fail({
      code: "STREAM_DUPLICATE_SUBSCRIPTION",
      retryable: false,
    });

    expect(resolveStreamAdmissionRetry(capacity, 5, 0)).toEqual({
      kind: "capacity",
      attempt: 6,
      delayMs: 1_000,
    });
    expect(resolveStreamAdmissionRetry(duplicate, 5, 0)).toEqual({
      kind: "duplicate",
      attempt: 1,
      delayMs: 250,
    });
    expect(
      resolveStreamAdmissionRetry(duplicate, 0, MAX_STREAM_DUPLICATE_RETRY_ATTEMPTS),
    ).toBeNull();
  });

  it("retries a missing draft snapshot until its projection becomes visible", () => {
    const projectionLag = Cause.fail({
      code: "THREAD_SNAPSHOT_NOT_FOUND",
      retryable: false,
    });

    expect(getThreadSnapshotBootstrapRetryDelayMs(projectionLag, 0)).toBe(100);
    expect(resolveStreamAdmissionRetry(projectionLag, 0, 0, 0)).toEqual({
      kind: "thread-bootstrap",
      attempt: 1,
      delayMs: 100,
    });
    expect(
      getThreadSnapshotBootstrapRetryDelayMs(
        projectionLag,
        MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
      ),
    ).toBeNull();
    expect(
      resolveStreamAdmissionRetry(
        projectionLag,
        0,
        0,
        MAX_THREAD_SNAPSHOT_BOOTSTRAP_RETRY_ATTEMPTS,
      ),
    ).toBeNull();
  });

  it("extracts the typed failure code used for thread stream failure reporting", () => {
    expect(
      getStreamFailureCode(Cause.fail({ code: "THREAD_SNAPSHOT_NOT_FOUND", retryable: false })),
    ).toBe("THREAD_SNAPSHOT_NOT_FOUND");
    expect(getStreamFailureCode(Cause.fail(new Error("transient")))).toBeNull();
  });

  it("treats structurally identical thread subscribe params as the same input", () => {
    const input = { threadId: "thread-1" };

    expect(threadStreamInputsEqual(input, input)).toBe(true);
    expect(threadStreamInputsEqual(input, { threadId: "thread-1" })).toBe(true);
    expect(threadStreamInputsEqual(input, { threadId: "thread-2" })).toBe(false);
    expect(threadStreamInputsEqual(input, { threadId: "thread-1", extra: true })).toBe(false);
    expect(threadStreamInputsEqual(undefined, { threadId: "thread-1" })).toBe(false);
  });

  it("delivers thread stream failures to listeners until they unsubscribe", () => {
    const { transport, internals } = makeBareTransport();
    const failure: WsThreadStreamFailure = {
      threadId: "thread-failed",
      code: "THREAD_SNAPSHOT_NOT_FOUND",
      error: new Error("snapshot missing"),
    };
    const throwing = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const listener = vi.fn();

    const unsubscribeThrowing = transport.onThreadStreamFailure(throwing);
    const unsubscribe = transport.onThreadStreamFailure(listener);
    internals.emitThreadStreamFailure(failure);

    expect(throwing).toHaveBeenCalledWith(failure);
    expect(listener).toHaveBeenCalledWith(failure);

    unsubscribe();
    unsubscribeThrowing();
    internals.emitThreadStreamFailure(failure);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("settles a stream that exits synchronously during callback registration", async () => {
    const { internals } = makeBareTransport();
    const key = "server.synchronous-exit";
    const cancel = vi.fn();
    Object.assign(internals, {
      disposed: false,
      getClientRuntime: vi.fn(() => ({
        runCallback: (_effect: unknown, options: { onExit: (exit: unknown) => void }) => {
          options.onExit(Exit.succeed(undefined));
          return cancel;
        },
      })),
    });

    expect(() => internals.startStream({}, key, {}, vi.fn())).not.toThrow();
    expect(internals.streamCleanups.has(key)).toBe(false);
    expect(internals.streamSettled.has(key)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("replaces the RPC session when an unbounded stream completes cleanly", async () => {
    const { internals } = makeBareTransport();
    const key = "orchestration.sync";
    const reconnect = vi.fn().mockResolvedValue({ id: "replacement" });
    const restart = vi.fn();
    let onExit: ((exit: Exit.Exit<unknown, unknown>) => void) | undefined;
    Object.assign(internals, {
      disposed: false,
      reconnect,
      getClientRuntime: vi.fn(() => ({
        runCallback: (_effect: unknown, options: { onExit: typeof onExit }) => {
          onExit = options.onExit;
          return vi.fn();
        },
      })),
    });

    internals.startStream({}, key, {}, vi.fn(), restart);
    onExit?.(Exit.succeed(undefined));
    await Promise.resolve();

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not let stale or duplicate thread restarts replace the active stream", async () => {
    const { internals } = makeBareTransport();
    const threadId = "thread-current-generation";
    const key = `cleanCore.thread:${threadId}`;
    const currentInput = { threadId, generation: "current" };
    const staleInput = { threadId, generation: "stale" };
    const cleanup = vi.fn();
    internals.cleanCoreThreadSubscriptions.set(threadId, currentInput);
    internals.streamCleanups.set(key, cleanup);
    internals.activeCleanCoreThreadInputs.set(key, currentInput);

    await internals.startCleanCoreThreadStream({}, threadId, staleInput);
    await internals.startCleanCoreThreadStream({}, threadId, currentInput);

    expect(cleanup).not.toHaveBeenCalled();
    expect(internals.streamCleanups.get(key)).toBe(cleanup);
  });

  it("starts a clean-core thread stream for a subscribeThread request", async () => {
    const { transport, internals } = makeBareTransport();
    const threadId = "thread-clean-core";
    const client = {};
    const startCleanCoreThreadStream = vi.fn(async () => undefined);
    Object.assign(internals, {
      disposed: false,
      getClient: vi.fn(async () => client),
      startCleanCoreThreadStream,
    });
    await transport.request(WS_METHODS.cleanCoreSubscribeThread, { threadId });
    expect(startCleanCoreThreadStream).toHaveBeenCalledWith(client, threadId, { threadId });
  });

  it("starts the clean-core stream under its own key and channel", async () => {
    const { internals } = makeBareTransport();
    const threadId = "thread-clean-core-key";
    const key = `cleanCore.thread:${threadId}`;
    const input = { threadId };
    const subscribe = vi.fn(() => ({}));
    const stopStream = vi.fn(async () => {
      internals.streamCleanups.delete(key);
      internals.activeCleanCoreThreadInputs.delete(key);
    });
    const startStream = vi.fn();
    Object.assign(internals, { disposed: false, sessionVersion: 7, stopStream, startStream });
    internals.cleanCoreThreadSubscriptions.set(threadId, input);
    await internals.startCleanCoreThreadStream(
      { [WS_METHODS.cleanCoreSubscribeThread]: subscribe },
      threadId,
      input,
    );
    expect(subscribe).toHaveBeenCalledWith(input);
    expect(startStream).toHaveBeenCalledWith(
      expect.anything(),
      key,
      {},
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("latches terminal compatibility guidance for late UI subscribers", () => {
    const issue = new WsCompatibilityError({
      message: "Update this client.",
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
      serverBuild: "0.5.2",
      protocolEpoch: WS_PROTOCOL_EPOCH,
      minRevision: WS_PROTOCOL_MIN_REVISION,
      maxRevision: WS_PROTOCOL_MAX_REVISION,
    });
    const listener = vi.fn();

    emitWsCompatibilityIssue(issue);
    const unsubscribe = addWsCompatibilityIssueListener(listener, { replayCurrent: true });

    expect(readLatestWsCompatibilityIssue()).toBe(issue);
    expect(listener).toHaveBeenCalledWith(issue);
    expect(getTerminalCompatibilityError(issue)).toBe(issue);

    unsubscribe();
    emitWsCompatibilityIssue(null);
  });

  it("owns request deadlines and external aborts without leaving timers active", async () => {
    vi.useFakeTimers();
    try {
      const deadline = makeRequestAbortScope({ timeoutMs: 25 });
      expect(deadline.signal?.aborted).toBe(false);
      expect(deadline.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      expect(deadline.signal?.aborted).toBe(true);
      expect(deadline.didTimeout()).toBe(true);
      deadline.cleanup();
      deadline.cleanup();

      const external = new AbortController();
      const cancelled = makeRequestAbortScope({ timeoutMs: 1_000, signal: external.signal });
      external.abort(new Error("cancelled by caller"));
      expect(cancelled.signal?.aborted).toBe(true);
      expect(cancelled.didTimeout()).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(cancelled.didTimeout()).toBe(false);
      cancelled.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shared lifecycle stream while either lifecycle channel is active", () => {
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverWelcome]))).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverMaintenanceUpdated]))).toBe(
      true,
    );
    expect(
      shouldKeepServerLifecycleStream(
        new Set([WS_CHANNELS.serverWelcome, WS_CHANNELS.serverMaintenanceUpdated]),
      ),
    ).toBe(true);
    expect(shouldKeepServerLifecycleStream(new Set([WS_CHANNELS.serverConfigUpdated]))).toBe(false);
  });

  it("keeps one config stream while either config or catalog changes are consumed", () => {
    expect(shouldKeepServerConfigStream(new Set([WS_CHANNELS.serverConfigUpdated]))).toBe(true);
    expect(shouldKeepServerConfigStream(new Set([WS_CHANNELS.providerCatalogChanged]))).toBe(true);
    expect(
      shouldKeepServerConfigStream(
        new Set([WS_CHANNELS.serverConfigUpdated, WS_CHANNELS.providerCatalogChanged]),
      ),
    ).toBe(true);
    expect(shouldKeepServerConfigStream(new Set([WS_CHANNELS.serverWelcome]))).toBe(false);
    expect(shouldKeepServerConfigStream(new Set())).toBe(false);
  });

  it("opens the stable bootstrap endpoint before the feature RPC socket", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    await socketCreated;

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");
    expect(transport.getState()).toBe("connecting");

    await transport.dispose();
  });

  it("uses the desktop bridge URL before falling back to the browser location", async () => {
    const getWsUrl = vi.fn().mockReturnValue("ws://127.0.0.1:53036/?token=old");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", port: "3020" },
        desktopBridge: { getWsUrl },
      },
    });

    const transport = new WsTransport();

    expect(getWsUrl).toHaveBeenCalledTimes(1);
    await socketCreated;
    expect(sockets[0]?.url).toBe("ws://127.0.0.1:53036/ws/bootstrap?token=old");

    await transport.dispose();
  });

  it("falls back to the current browser host when no desktop bridge URL exists", async () => {
    const transport = new WsTransport();
    await socketCreated;

    expect(sockets[0]?.url).toBe("ws://localhost:3020/ws/bootstrap");

    await transport.dispose();
  });

  it("pins the feature socket to the negotiated revision and server generation", () => {
    const resolved = new URL(
      makeFeatureSocketUrl("ws://127.0.0.1:53036/?token=old", {
        protocolEpoch: WS_PROTOCOL_EPOCH,
        negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
        serverBuild: "0.5.2",
        serverInstanceId: "server-instance",
        capabilities: ["orchestration.cursor-safe-streams"],
      }),
    );

    expect(resolved.pathname).toBe("/ws");
    expect(resolved.searchParams.get("token")).toBe("old");
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.protocolRevision)).toBe(
      String(WS_PROTOCOL_MAX_REVISION),
    );
    expect(resolved.searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)).toBe(
      "server-instance",
    );
  });

  it("notifies state listeners and replays the current state on demand", async () => {
    const transport = new WsTransport();
    const listener = vi.fn();

    const unsubscribe = transport.onStateChange(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledWith("connecting");

    listener.mockClear();
    await transport.dispose();

    expect(listener).toHaveBeenCalledWith("disposed");

    listener.mockClear();
    unsubscribe();
    await transport.dispose();

    expect(listener).not.toHaveBeenCalled();
  });

  it("retries an idempotent orchestration command after reconnect", async () => {
    const transport = makeControlledTransport();
    const method = WS_METHODS.cleanCoreSendMessage;
    const firstClient = { [method]: vi.fn((_input: unknown) => ({ attempt: 1 })) };
    const secondClient = { [method]: vi.fn((_input: unknown) => ({ attempt: 2 })) };
    const firstRuntime = {
      runPromise: vi.fn().mockRejectedValue(
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006 }),
        }),
      ),
    };
    const secondRuntime = {
      runPromise: vi.fn().mockResolvedValue({ sequence: 42 }),
    };
    const reconnect = vi.fn().mockResolvedValue(secondClient);
    const internals = transport as unknown as {
      getClient: () => Promise<typeof firstClient>;
      getClientRuntime: (client: unknown) => typeof firstRuntime | typeof secondRuntime;
      reconnect: () => Promise<typeof secondClient>;
    };
    internals.getClient = vi.fn().mockResolvedValue(firstClient);
    internals.getClientRuntime = vi.fn((client) =>
      client === firstClient ? firstRuntime : secondRuntime,
    );
    internals.reconnect = reconnect;

    await expect(
      transport.request(
        method,
        {
          commandId: "stable-command-id",
        },
        { timeoutMs: null, retryOnReconnect: true },
      ),
    ).resolves.toEqual({ sequence: 42 });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(firstClient[method]).toHaveBeenCalledTimes(1);
    expect(secondClient[method]).toHaveBeenCalledTimes(1);
    expect(firstClient[method].mock.calls[0]?.[0]).toEqual({ commandId: "stable-command-id" });
    expect(secondClient[method].mock.calls[0]?.[0]).toEqual({ commandId: "stable-command-id" });
    await transport.dispose();
  });

  it("reconnects requests only for transport failures", () => {
    expect(
      shouldReconnectAfterRequestFailure(
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006 }),
        }),
      ),
    ).toBe(true);
    expect(
      shouldReconnectAfterRequestFailure(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "invalid payload",
            cause: new Error("schema failure"),
          }),
        }),
      ),
    ).toBe(false);
    expect(shouldReconnectAfterRequestFailure(new Error("invalid payload"))).toBe(false);
  });

  it("joins an active reconnect instead of returning the retired client", async () => {
    const transport = makeControlledTransport();
    const retiredClient = { id: "retired" };
    const replacementClient = { id: "replacement" };
    let resolveReconnect!: (client: typeof replacementClient) => void;
    const reconnectPromise = new Promise<typeof replacementClient>((resolve) => {
      resolveReconnect = resolve;
    });
    const internals = transport as unknown as {
      getClient: () => Promise<typeof retiredClient | typeof replacementClient>;
      clientPromise: Promise<typeof retiredClient>;
      reconnectPromise: Promise<typeof replacementClient> | null;
    };
    internals.clientPromise = Promise.resolve(retiredClient);
    internals.reconnectPromise = reconnectPromise;

    const clientPromise = internals.getClient();
    resolveReconnect(replacementClient);

    await expect(clientPromise).resolves.toBe(replacementClient);
    internals.reconnectPromise = null;
    await transport.dispose();
  });

  it("publishes one reconnect before old-scope teardown can re-enter", async () => {
    const { internals } = makeBareTransport();
    const replacementClient = { id: "replacement" };
    let reentrantReconnect: Promise<typeof replacementClient> | undefined;
    const openReconnectSession = vi.fn().mockResolvedValue(replacementClient);
    const oldRuntime = {
      runPromise: vi.fn(() => {
        reentrantReconnect = transportInternals.reconnect();
        return Promise.resolve(undefined);
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const transportInternals = internals as unknown as {
      runtime: typeof oldRuntime;
      clientScope: Scope.Scope;
      state: string;
      readonly stateListeners: Set<(state: string) => void>;
      reconnectPromise: Promise<typeof replacementClient> | null;
      reconnect: () => Promise<typeof replacementClient>;
      openReconnectSession: () => Promise<typeof replacementClient>;
    };
    Object.assign(transportInternals, {
      runtime: oldRuntime,
      clientScope: Effect.runSync(Scope.make()),
      state: "open",
      stateListeners: new Set(),
      reconnectPromise: null,
      openReconnectSession,
    });

    const reconnect = transportInternals.reconnect();
    await Promise.resolve();

    expect(reentrantReconnect).toBe(reconnect);
    await expect(reconnect).resolves.toBe(replacementClient);
    expect(openReconnectSession).toHaveBeenCalledTimes(1);
    expect(oldRuntime.runPromise).toHaveBeenCalledTimes(1);
    expect(oldRuntime.dispose).toHaveBeenCalledTimes(1);
    expect(transportInternals.reconnectPromise).toBeNull();
  });

  it("shares one reconnect when cancelling multiple streams synchronously re-enters", async () => {
    const { internals } = makeBareTransport();
    const replacementClient = { id: "replacement" };
    const openReconnectSession = vi.fn().mockResolvedValue(replacementClient);
    const oldRuntime = {
      runPromise: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const transportInternals = internals as unknown as {
      reconnect: () => Promise<typeof replacementClient>;
    };
    Object.assign(internals, {
      runtime: oldRuntime,
      clientScope: Effect.runSync(Scope.make()),
      state: "open",
      stateListeners: new Set(),
      reconnectPromise: null,
      openReconnectSession,
    });
    const reentrantReconnects: Array<Promise<typeof replacementClient>> = [];
    for (const key of ["server.config", "orchestration.sync"]) {
      internals.streamCleanups.set(key, () => {
        internals.streamCleanups.delete(key);
        reentrantReconnects.push(transportInternals.reconnect());
      });
    }

    const reconnect = transportInternals.reconnect();
    await expect(reconnect).resolves.toBe(replacementClient);
    await Promise.all(reentrantReconnects);

    expect(reentrantReconnects).toHaveLength(2);
    expect(reentrantReconnects.every((pending) => pending === reconnect)).toBe(true);
    expect(openReconnectSession).toHaveBeenCalledTimes(1);
    expect(oldRuntime.dispose).toHaveBeenCalledTimes(1);
  });

  it("moves a hung initial connection into the reconnect path", async () => {
    vi.useFakeTimers();
    try {
      window.desktopBridge = {
        getWsUrl: () => null,
      } as never;
      window.setTimeout = globalThis.setTimeout.bind(globalThis);
      window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
      const transport = makeControlledTransport(new Promise(() => undefined));
      const recoveredClient = { id: "recovered-after-initial-timeout" };
      const reconnect = vi.fn().mockResolvedValue(recoveredClient);
      const internals = transport as unknown as {
        clientPromise: Promise<typeof recoveredClient>;
        reconnectPromise: Promise<typeof recoveredClient> | null;
        withConnectionAttemptTimeout: (
          promise: Promise<typeof recoveredClient>,
        ) => Promise<typeof recoveredClient>;
        getClient: () => Promise<typeof recoveredClient>;
        reconnect: typeof reconnect;
      };
      void internals.clientPromise.catch(() => undefined);
      internals.reconnectPromise = null;
      internals.reconnect = reconnect;

      const client = internals.getClient();
      await vi.advanceTimersByTimeAsync(WS_RECONNECT_ATTEMPT_TIMEOUT_MS);

      await expect(client).resolves.toBe(recoveredClient);
      expect(reconnect).toHaveBeenCalledTimes(1);
      await transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the constructor's first failed connection", async () => {
    window.desktopBridge = {
      getWsUrl: () => null,
    } as never;
    const session = vi
      .spyOn(WsTransport.prototype as unknown as { createSession: () => unknown }, "createSession")
      .mockReturnValue({
        runtime: {
          runPromise: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn().mockResolvedValue(undefined),
        },
        clientScope: Effect.runSync(Scope.make()),
        clientPromise: Promise.reject(
          Object.assign(new Error("offline"), { code: "ECONNREFUSED" }),
        ),
      } as never);
    try {
      const transport = new WsTransport();
      const initial = (transport as unknown as { clientPromise: Promise<unknown> }).clientPromise;
      await expect(initial).rejects.toThrow("offline");
      await transport.dispose();
    } finally {
      session.mockRestore();
    }
  });

  it("returns every failed reconnect handshake attempt", async () => {
    window.desktopBridge = {
      getWsUrl: () => null,
    } as never;
    const transport = makeControlledTransport();
    const attempt = (
      transport as unknown as {
        withConnectionAttemptTimeout: (promise: Promise<unknown>) => Promise<unknown>;
      }
    ).withConnectionAttemptTimeout.bind(transport);
    await expect(attempt(Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    await expect(attempt(Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    await expect(
      attempt(Promise.reject(Object.assign(new Error("offline"), { code: "ECONNRESET" }))),
    ).rejects.toThrow("offline");
    await transport.dispose();
  });

  it("abandons a hung reconnect attempt and keeps recovering", async () => {
    vi.useFakeTimers();
    try {
      window.setTimeout = globalThis.setTimeout.bind(globalThis);
      window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
      const transport = makeControlledTransport();
      const firstScope = Effect.runSync(Scope.make());
      const secondScope = Effect.runSync(Scope.make());
      const thirdScope = Effect.runSync(Scope.make());
      const firstRuntime = {
        runPromise: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const secondRuntime = {
        runPromise: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const thirdRuntime = {
        runPromise: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const recoveredClient = { id: "recovered" };
      const createSession = vi
        .fn()
        .mockReturnValueOnce({
          runtime: firstRuntime,
          clientScope: firstScope,
          clientPromise: new Promise(() => undefined),
        })
        .mockImplementationOnce(() => ({
          runtime: secondRuntime,
          clientScope: secondScope,
          clientPromise: Promise.reject(
            Object.assign(new Error("offline"), { code: "ECONNRESET" }),
          ),
        }))
        .mockReturnValueOnce({
          runtime: thirdRuntime,
          clientScope: thirdScope,
          clientPromise: Promise.resolve(recoveredClient),
        });
      const internals = transport as unknown as {
        disposed: boolean;
        reconnectFailures: number;
        clientPromise: Promise<unknown>;
        createSession: typeof createSession;
        openReconnectSession: () => Promise<typeof recoveredClient>;
      };
      void internals.clientPromise.catch(() => undefined);
      internals.createSession = createSession;
      internals.reconnectFailures = 0;

      const reconnect = internals.openReconnectSession();
      await vi.advanceTimersByTimeAsync(500);
      expect(createSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(WS_RECONNECT_ATTEMPT_TIMEOUT_MS + 1_000 + 2_000);

      await expect(reconnect).resolves.toBe(recoveredClient);
      expect(createSession).toHaveBeenCalledTimes(3);
      expect(firstRuntime.dispose).toHaveBeenCalledTimes(1);
      expect(secondRuntime.dispose).toHaveBeenCalledTimes(1);
      internals.disposed = true;
      await thirdRuntime.runPromise(Scope.close(thirdScope, Exit.void));
      await thirdRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an explicit orchestration rejection", async () => {
    const transport = makeControlledTransport();
    const method = WS_METHODS.cleanCoreSendMessage;
    const client = { [method]: vi.fn(() => ({})) };
    const rejection = new WsRpcError({ message: "command rejected", retryable: false });
    const runtime = { runPromise: vi.fn().mockRejectedValue(rejection) };
    const reconnect = vi.fn();
    const internals = transport as unknown as {
      getClient: () => Promise<typeof client>;
      getClientRuntime: () => typeof runtime;
      reconnect: () => Promise<typeof client>;
    };
    internals.getClient = vi.fn().mockResolvedValue(client);
    internals.getClientRuntime = vi.fn(() => runtime);
    internals.reconnect = reconnect;

    await expect(
      transport.request(method, {}, { timeoutMs: null, retryOnReconnect: true }),
    ).rejects.toBe(rejection);
    expect(reconnect).not.toHaveBeenCalled();
    await transport.dispose();
  });
});

describe("mobile pairing subscriptions", () => {
  it("clears an old prompt on disconnect and resubscribes on the next open", async () => {
    const { transport } = makeBareTransport();
    const queue = await Effect.runPromise(
      Queue.unbounded<{
        request: null | {
          requestId: string;
          phoneDeviceId: string;
          phoneName: string;
          phoneModel: string;
          code: string;
        };
      }>(),
    );
    const subscribe = vi.fn(() => Stream.fromQueue(queue));
    let change!: (state: "open" | "closed") => void;
    Object.assign(transport, {
      onStateChange: (listener: typeof change) => {
        change = listener;
        listener("open");
        return () => undefined;
      },
      getClient: async () => ({ [WS_METHODS.remoteSubscribePairing]: subscribe }),
      getClientRuntime: () => ({
        runCallback: (
          effect: Effect.Effect<void>,
          options: { onExit: (exit: Exit.Exit<void>) => void },
        ) => Effect.runCallback(effect, options),
      }),
    });
    let resolveFirst!: () => void, resolveSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const seen: (string | null)[] = [];
    const stop = transport.subscribePairing(
      (request) => {
        seen.push(request?.requestId ?? null);
        if (request && seen.length === 1) resolveFirst();
        if (request && seen.length === 3) resolveSecond();
      },
      (error) => {
        throw error;
      },
    );
    const request = {
      requestId: "one",
      phoneDeviceId: "p",
      phoneName: "Phone",
      phoneModel: "Fixture",
      code: "123456",
    };
    await Effect.runPromise(Queue.offer(queue, { request }));
    await first;
    change("closed");
    change("open");
    await Effect.runPromise(Queue.offer(queue, { request: { ...request, requestId: "two" } }));
    await second;
    expect(seen).toEqual(["one", null, "two"]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    stop();
    await Effect.runPromise(Queue.shutdown(queue));
  });
});

describe("provider sign-in subscriptions", () => {
  it("delivers pushed snapshots and cancels the stream on cleanup", async () => {
    const { transport } = makeBareTransport();
    const queue = await Effect.runPromise(Queue.unbounded<unknown>());
    const subscribe = vi.fn(() => Stream.fromQueue(queue));
    const cancel = vi.fn();
    Object.assign(transport, {
      getClient: async () => ({ [WS_METHODS.providerSubscribeConnectionLogin]: subscribe }),
      getClientRuntime: () => ({
        runCallback: (
          effect: Effect.Effect<void>,
          options: { onExit: (exit: Exit.Exit<void>) => void },
        ) => {
          const stop = Effect.runCallback(effect, options);
          return () => {
            cancel();
            stop();
          };
        },
      }),
    });
    const pushed = new Promise<unknown>((resolve) => {
      const unsubscribe = transport.subscribeConnectionLogin(
        { operationId: "login-one" },
        (snapshot) => {
          resolve(snapshot);
          unsubscribe();
        },
        (error) => {
          throw error;
        },
      );
    });
    const snapshot = { operationId: "login-one", state: "completed" };
    await Effect.runPromise(Queue.offer(queue, snapshot));
    expect(await pushed).toEqual(snapshot);
    expect(subscribe).toHaveBeenCalledWith({ operationId: "login-one" });
    expect(cancel).toHaveBeenCalledOnce();
    await Effect.runPromise(Queue.shutdown(queue));
  });

  it("does not register a stream when cleaned up before the client arrives", async () => {
    const { transport } = makeBareTransport();
    let resolve!: (client: unknown) => void;
    const client = new Promise((ready) => {
      resolve = ready;
    });
    const runtime = vi.fn();
    Object.assign(transport, { getClient: () => client, getClientRuntime: runtime });
    const unsubscribe = transport.subscribeConnectionLogin(
      { operationId: "login-one" },
      vi.fn(),
      vi.fn(),
    );
    unsubscribe();
    resolve({});
    await client;
    expect(runtime).not.toHaveBeenCalled();
  });

  it("surfaces a failed subscription instead of polling or retrying", async () => {
    const { transport } = makeBareTransport();
    const error = new WsRpcError({ message: "Sign in no longer exists." });
    const subscribe = vi.fn(() => Stream.fail(error));
    Object.assign(transport, {
      getClient: async () => ({ [WS_METHODS.providerSubscribeConnectionLogin]: subscribe }),
      getClientRuntime: () => ({ runCallback: Effect.runCallback }),
    });
    const failure = await new Promise<Error>((resolve) => {
      transport.subscribeConnectionLogin({ operationId: "login-one" }, vi.fn(), resolve);
    });
    expect(failure.message).toContain(error.message);
    expect(subscribe).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { httpFixture } from "./httpFixture.test-support";
import { RemoteRelayConnection } from "./relayConnection";
import type { RelayReconnectState } from "./reconnect";
import {
  encodeRelayFrame,
  decodeRelayFrame,
  RELAY_MAX_FRAME_BYTES,
  RELAY_ZERO_ID,
  RelayFrameType,
  RelayOpenMode,
} from "./relayProtocol";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("real relay reconnection", () => {
  it("sends sleep before closing the relay and joining session cleanup", async () => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true });
        const received = Promise.withResolvers<ReturnType<typeof decodeRelayFrame>>();
        server.on("upgrade", (request, socket, head) =>
          wss.handleUpgrade(request, socket, head, (ws) => {
            ws.on("message", (data) => received.resolve(decodeRelayFrame(data as Buffer)));
          }),
        );
        const opened = Promise.withResolvers<void>();
        const cleanup = vi.fn(async () => undefined);
        const connection = new RemoteRelayConnection({
          url: origin.replace("http:", "ws:") + "/v1",
          deviceToken: "fixture",
          signal: new AbortController().signal,
          onFrame: () => undefined,
          onOpen: () => {
            opened.resolve();
            return cleanup;
          },
          observe: () => undefined,
          observeReconnect: () => undefined,
        });
        try {
          await opened.promise;
          await connection.sleep();
          expect(await received.promise).toEqual({
            type: RelayFrameType.SLEEP,
            sessionId: RELAY_ZERO_ID,
            peerId: RELAY_ZERO_ID,
            payload: Buffer.alloc(0),
          });
          expect(cleanup).toHaveBeenCalledOnce();
        } finally {
          await connection.close();
          for (const socket of wss.clients) socket.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });
  it("installs the session owner before dispatching an immediately arriving OPEN", async () => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true });
        server.on("upgrade", (request, socket, head) =>
          wss.handleUpgrade(request, socket, head, (ws) =>
            ws.send(
              encodeRelayFrame({
                type: RelayFrameType.OPEN,
                mode: RelayOpenMode.PAIRING,
                sessionId: "10000000-0000-4000-8000-000000000001",
                peerId: "10000000-0000-4000-8000-000000000002",
                payload: new Uint8Array([1]),
              }),
            ),
          ),
        );
        let ownerInstalled = false;
        const delivered = Promise.withResolvers<boolean>();
        const connection = new RemoteRelayConnection({
          url: origin.replace("http:", "ws:") + "/v1",
          deviceToken: "fixture",
          signal: new AbortController().signal,
          onFrame: () => {
            delivered.resolve(ownerInstalled);
            return undefined;
          },
          onOpen: () => {
            ownerInstalled = true;
            return async () => undefined;
          },
          observe: () => undefined,
          observeReconnect: () => undefined,
        });
        try {
          expect(await delivered.promise).toBe(true);
        } finally {
          await connection.close();
          for (const socket of wss.clients) socket.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });
  it.each([
    [401, "authentication-rejected"],
    [403, "authentication-rejected"],
    [426, "protocol-rejected"],
  ] as const)("HTTP %s stops without a retry timer", async (status, reason) => {
    vi.useFakeTimers();
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        let requests = 0;
        server.on("upgrade", (_request, socket) => {
          requests++;
          socket.end(
            `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
        });
        const rejected = Promise.withResolvers<RelayReconnectState>();
        const connection = new RemoteRelayConnection({
          url: origin.replace("http:", "ws:") + "/v1",
          deviceToken: "private-token",
          signal: new AbortController().signal,
          onFrame: () => undefined,
          onOpen: () => {
            throw new Error("Rejected handshakes cannot open a session.");
          },
          observe: () => undefined,
          observeReconnect: (state) => {
            if (state.state === "rejected") rejected.resolve(state);
          },
        });
        try {
          expect(await rejected.promise).toEqual({ state: "rejected", reason });
          expect(vi.getTimerCount()).toBe(0);
          await vi.advanceTimersByTimeAsync(1_000_000);
          expect(requests).toBe(1);
        } finally {
          await connection.close();
        }
      },
    );
  });

  it.each(["text", "oversized"])(
    "a %s relay frame stops and releases the session owner",
    async (kind) => {
      await httpFixture(
        (_request, response) => response.end(),
        async (origin, server) => {
          const wss = new WebSocketServer({ noServer: true });
          server.on("upgrade", (request, socket, head) =>
            wss.handleUpgrade(request, socket, head, (ws) =>
              ws.send(
                kind === "text" ? "invalid-text-frame" : Buffer.alloc(RELAY_MAX_FRAME_BYTES + 1),
              ),
            ),
          );
          const rejected = Promise.withResolvers<RelayReconnectState>();
          const cleaned = vi.fn(async () => undefined);
          const connection = new RemoteRelayConnection({
            url: origin.replace("http:", "ws:") + "/v1",
            deviceToken: "private-token",
            signal: new AbortController().signal,
            onFrame: () => undefined,
            onOpen: () => cleaned,
            observe: () => undefined,
            observeReconnect: (state) => {
              if (state.state === "rejected" || state.state === "waiting") rejected.resolve(state);
            },
          });
          try {
            expect(await rejected.promise).toEqual({
              state: "rejected",
              reason: "protocol-rejected",
            });
            expect(cleaned).toHaveBeenCalledTimes(1);
          } finally {
            await connection.close();
            for (const socket of wss.clients) socket.terminate();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
          }
        },
      );
    },
  );

  it("wake replaces a live connection only after session cleanup, and parent abort stops it", async () => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true });
        let upgrades = 0;
        server.on("upgrade", (request, socket, head) => {
          upgrades++;
          wss.handleUpgrade(request, socket, head, () => undefined);
        });
        const opened = Promise.withResolvers<void>();
        const cleanupStarted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const reopened = Promise.withResolvers<void>();
        const parent = new AbortController();
        let opens = 0;
        let cleanups = 0;
        const connection = new RemoteRelayConnection({
          url: origin.replace("http:", "ws:") + "/v1",
          deviceToken: "private-token",
          signal: parent.signal,
          onFrame: () => undefined,
          onOpen: () => {
            opens++;
            if (opens === 1) opened.resolve();
            else reopened.resolve();
            return async () => {
              cleanups++;
              if (cleanups === 1) {
                cleanupStarted.resolve();
                await release.promise;
              }
            };
          },
          observe: () => undefined,
          observeReconnect: () => undefined,
        });
        try {
          await opened.promise;
          connection.reconnect("wake");
          await cleanupStarted.promise;
          expect(upgrades).toBe(1);
          release.resolve();
          await reopened.promise;
          expect(upgrades).toBe(2);
          parent.abort();
          await connection.finished;
          expect(cleanups).toBe(2);
        } finally {
          release.resolve();
          await connection.close();
          for (const socket of wss.clients) socket.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });

  it("an already aborted parent makes no connection", async () => {
    const parent = new AbortController();
    parent.abort();
    const states: RelayReconnectState[] = [];
    const connection = new RemoteRelayConnection({
      url: "not a URL",
      deviceToken: "private-token",
      signal: parent.signal,
      onFrame: () => undefined,
      onOpen: () => {
        throw new Error("An aborted owner cannot open.");
      },
      observe: () => undefined,
      observeReconnect: (state) => states.push(state),
    });
    await connection.finished;
    expect(states).toEqual([{ state: "connecting" }, { state: "stopped" }]);
  });
});

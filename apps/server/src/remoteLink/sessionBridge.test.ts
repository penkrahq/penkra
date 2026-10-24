import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocketServer } from "ws";
import { httpFixture } from "./httpFixture.test-support";
import { NoiseCipher } from "./noise";
import { RemoteSessionBridge, type RemoteSessionEvent } from "./sessionBridge";
import { encodeTunnelEnvelope, decodeTunnelEnvelope, type TunnelEnvelope } from "./tunnelCodec";

function fixture(origin = "http://127.0.0.1:1", sendWire?: (bytes: Uint8Array) => Promise<void>) {
  const first = new Uint8Array(32).fill(1),
    second = new Uint8Array(32).fill(2);
  const phone = { send: new NoiseCipher(second), receive: new NoiseCipher(first) };
  const events: RemoteSessionEvent[] = [];
  const viewing: (string | null)[] = [];
  const bridge = new RemoteSessionBridge({
    phoneDeviceId: "fixture-phone",
    sessionId: "fixture-session",
    origin,
    credential: "private-fixture-bearer",
    transport: { send: new NoiseCipher(first), receive: new NoiseCipher(second) },
    sendWire:
      sendWire ??
      (async (bytes) => {
        decodeTunnelEnvelope(phone.receive.decrypt(bytes));
      }),
    observe: (event) => events.push(event),
    onViewing: (value) => viewing.push(value),
  });
  return {
    bridge,
    events,
    viewing,
    send: (envelope: TunnelEnvelope) =>
      bridge.receive(phone.send.encrypt(encodeTunnelEnvelope(envelope))),
    async close() {
      await bridge.close();
      phone.send.destroy();
      phone.receive.destroy();
    },
  };
}

describe("authenticated session resource ownership", () => {
  it("closes without waiting for a relay-owned write that is backpressured", async () => {
    await httpFixture(
      (_request, response) => response.end("fixture payload"),
      async (origin) => {
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const owner = fixture(origin, async () => {
          entered.resolve();
          await release.promise;
        });
        onTestFinished(async () => {
          release.resolve();
          await owner.close();
        });
        try {
          owner.send({ t: "http", id: 1, method: "GET", path: "/attachments/file" });
          await entered.promise;
          await owner.bridge.close();
          expect(owner.bridge.channel.signal.aborted).toBe(true);
          expect(owner.viewing).toEqual([null]);
        } finally {
          release.resolve();
          await owner.close();
        }
      },
    );
  });
  it("closes active HTTP and WebSocket connections and clears viewing exactly once", async () => {
    const httpOpened = Promise.withResolvers<void>();
    const httpClosed = Promise.withResolvers<void>();
    const wsOpened = Promise.withResolvers<void>();
    const wsClosed = Promise.withResolvers<void>();
    await httpFixture(
      (_request, response) => {
        response.once("close", () => httpClosed.resolve());
        response.writeHead(200);
        response.flushHeaders();
        httpOpened.resolve();
      },
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true });
        server.on("upgrade", (request, socket, head) =>
          wss.handleUpgrade(request, socket, head, (ws) => {
            ws.once("close", () => wsClosed.resolve());
            wsOpened.resolve();
          }),
        );
        const owner = fixture(origin);
        try {
          owner.send({ t: "http", id: 1, method: "GET", path: "/attachments/file" });
          owner.send({ t: "ws.open", id: 2, path: "/ws/bootstrap" });
          owner.send({ t: "viewing", threadId: "thread-1" });
          await Promise.all([httpOpened.promise, wsOpened.promise]);
          const closing = owner.bridge.close();
          expect(owner.bridge.close()).toBe(closing);
          expect(owner.bridge.channel.signal.aborted).toBe(true);
          expect(owner.bridge.viewingThreadId).toBeNull();
          await closing;
          await Promise.all([httpClosed.promise, wsClosed.promise]);
          expect(owner.viewing).toEqual(["thread-1", null]);
          expect(
            owner.events.filter((event) => event.transport === "noise" && event.event === "closed"),
          ).toHaveLength(1);
          expect(JSON.stringify(owner.events)).not.toContain("private-fixture-bearer");
        } finally {
          await owner.close();
          for (const ws of wss.clients) ws.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });

  it("rejects a server-only envelope without stopping another session", async () => {
    const first = fixture(),
      second = fixture();
    try {
      first.send({ t: "viewing", threadId: "thread-1" });
      first.send({ t: "http.res", id: 1, status: 200, headers: {} });
      await first.bridge.close();
      second.send({ t: "viewing", threadId: "thread-2" });
      expect(first.bridge.channel.signal.aborted).toBe(true);
      expect(first.viewing).toEqual(["thread-1", null]);
      expect(second.bridge.channel.signal.aborted).toBe(false);
      expect(second.bridge.viewingThreadId).toBe("thread-2");
      expect(first.events.some((event) => event.event === "protocol-failed")).toBe(true);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("closes after failed ciphertext authentication", async () => {
    const owner = fixture();
    try {
      owner.send({ t: "viewing", threadId: "thread-1" });
      owner.bridge.receive(new Uint8Array(16));
      await owner.bridge.close();
      expect(owner.bridge.channel.signal.aborted).toBe(true);
      expect(owner.viewing).toEqual(["thread-1", null]);
    } finally {
      await owner.close();
    }
  });
});

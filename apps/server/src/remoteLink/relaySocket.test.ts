import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { httpFixture } from "./httpFixture.test-support";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  RELAY_MAX_FRAME_BYTES,
  RELAY_ZERO_ID,
  RelayFrameType,
  type RelayFrame,
} from "./relayProtocol";
import { RemoteRelaySocket, type RelaySocketEvent } from "./relaySocket";

const frame: RelayFrame = {
  type: RelayFrameType.SLEEP,
  sessionId: RELAY_ZERO_ID,
  peerId: RELAY_ZERO_ID,
  payload: new Uint8Array(),
};
const urlFor = (origin: string) => origin.replace("http:", "ws:") + "/v1";

describe("real RemoteLink relay socket", () => {
  it("authenticates with headers, preserves binary frames and receives immediately on open", async () => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true });
        const received = Promise.withResolvers<RelayFrame>();
        const observed = Promise.withResolvers<{
          authorization: string | undefined;
          version: string | string[] | undefined;
          binary: boolean;
          frame: RelayFrame;
        }>();
        server.on("upgrade", (request, socket, head) =>
          wss.handleUpgrade(request, socket, head, (ws) => {
            ws.send(encodeRelayFrame(frame));
            ws.once("message", (bytes, binary) => {
              observed.resolve({
                authorization: request.headers.authorization,
                version: request.headers["penkra-relay-version"],
                binary,
                frame: decodeRelayFrame(Buffer.from(bytes as Buffer)),
              });
              ws.close(1000);
            });
          }),
        );
        const events: RelaySocketEvent[] = [];
        const relay = await RemoteRelaySocket.open({
          url: urlFor(origin),
          deviceToken: "private-device-token",
          signal: new AbortController().signal,
          onFrame: (value) => {
            received.resolve(value);
            return undefined;
          },
          observe: (event) => {
            events.push(event);
          },
        });
        try {
          await relay.send(frame);
          expect(await received.promise).toEqual({ ...frame, payload: Buffer.alloc(0) });
          expect(await observed.promise).toEqual({
            authorization: "Bearer private-device-token",
            version: "1",
            binary: true,
            frame: { ...frame, payload: Buffer.alloc(0) },
          });
          expect(await relay.finished).toEqual({ code: 1000, reason: "remote-close" });
          expect(JSON.stringify(events)).not.toContain("private-device-token");
          await expect(relay.send(frame)).rejects.toMatchObject({ code: "closed" });
        } finally {
          relay.close();
          await relay.finished;
          for (const ws of wss.clients) ws.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });

  it.each(["text", "oversized", "invalid-version"])("closes on a %s relay frame", async (kind) => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true });
        server.on("upgrade", (request, socket, head) =>
          wss.handleUpgrade(request, socket, head, (ws) => {
            const bytes = encodeRelayFrame(frame);
            bytes[0] = 2;
            ws.send(
              kind === "text"
                ? "not-binary"
                : kind === "oversized"
                  ? Buffer.alloc(RELAY_MAX_FRAME_BYTES + 1)
                  : bytes,
            );
          }),
        );
        let delivered = false;
        const relay = await RemoteRelaySocket.open({
          url: urlFor(origin),
          deviceToken: "fixture",
          signal: new AbortController().signal,
          onFrame: () => {
            delivered = true;
            return undefined;
          },
          observe: () => undefined,
        });
        try {
          const closed = await relay.finished;
          expect(closed.reason).toBe("protocol-failed");
          expect(delivered).toBe(false);
        } finally {
          relay.close();
          await relay.finished;
          for (const ws of wss.clients) ws.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });

  it("aborts an owned socket and never reconnects on its own", async () => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true });
        let connections = 0;
        server.on("upgrade", (request, socket, head) =>
          wss.handleUpgrade(request, socket, head, () => {
            connections++;
          }),
        );
        const abort = new AbortController();
        const relay = await RemoteRelaySocket.open({
          url: urlFor(origin),
          deviceToken: "fixture",
          signal: abort.signal,
          onFrame: () => undefined,
          observe: () => {
            throw new Error("observer");
          },
        });
        try {
          abort.abort();
          relay.close();
          expect((await relay.finished).reason).toBe("aborted");
          expect(connections).toBe(1);
        } finally {
          for (const ws of wss.clients) ws.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });

  it("cancels while the HTTP upgrade is still pending", async () => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const upgrading = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        server.on("upgrade", (_request, socket) => {
          socket.once("end", () => socket.end());
          socket.once("close", () => closed.resolve());
          socket.resume();
          upgrading.resolve();
        });
        const abort = new AbortController();
        const connecting = RemoteRelaySocket.open({
          url: urlFor(origin),
          deviceToken: "fixture",
          signal: abort.signal,
          onFrame: () => undefined,
          observe: () => undefined,
        });
        void connecting.catch(() => undefined);
        await upgrading.promise;
        abort.abort();
        await expect(connecting).rejects.toMatchObject({ code: "closed" });
        await closed.promise;
      },
    );
  });

  it.each([401, 302])(
    "reports HTTP %s without following redirects or disclosing the response",
    async (status) => {
      await httpFixture(
        (_request, response) => response.end(),
        async (origin, server) => {
          server.on("upgrade", (_request, socket) =>
            socket.end(
              `HTTP/1.1 ${status} Rejected\r\nLocation: /stolen\r\nContent-Length: 0\r\n\r\n`,
            ),
          );
          await expect(
            RemoteRelaySocket.open({
              url: urlFor(origin),
              deviceToken: "private-device-token",
              signal: new AbortController().signal,
              onFrame: () => undefined,
              observe: () => undefined,
            }),
          ).rejects.toMatchObject({
            code: "connection-failed",
            status,
            message: "RemoteLink relay connection-failed.",
          });
        },
      );
    },
  );

  it.each([
    "ws://example.com/v1",
    "wss://token@example.com/v1",
    "wss://example.com/v1?token=secret",
    "wss://example.com/other",
    "not a URL",
  ])("rejects an unsafe URL before opening: %s", async (url) => {
    await expect(
      RemoteRelaySocket.open({
        url,
        deviceToken: "fixture",
        signal: new AbortController().signal,
        onFrame: () => undefined,
        observe: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "invalid-url" });
  });
});

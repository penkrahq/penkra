import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { httpFixture } from "./httpFixture.test-support";
import { RemoteWsBridge } from "./wsBridge";
import { wsTextChunks } from "./wsTextChunks";
import { WsTextReceiver } from "./wsTextReceiver";
import { RPC_MESSAGE_OBSERVATION_BYTES } from "../rpcMessageSizes";
import type { TunnelEnvelope } from "./tunnelCodec";

describe("RemoteLink real loopback WebSocket bridge", () => {
  it("acknowledges discarded chunks for a closed stream before reporting the error", async () => {
    const sent: TunnelEnvelope[] = [];
    const bridge = new RemoteWsBridge({
      origin: "http://127.0.0.1:1",
      credential: "fixture",
      channel: {
        signal: new AbortController().signal,
        send: async (value) => {
          sent.push(value);
        },
      },
      observe: () => undefined,
    });
    try {
      await bridge.accept({ t: "ws.msg", id: 1, seq: 0, data: "late" });
      expect(sent).toEqual([
        { t: "ack", id: 1, seq: 0 },
        { t: "error", id: 1, reason: "unknown-ws-stream" },
      ]);
    } finally {
      await bridge.close();
    }
  });
  it("preserves text frames, Unicode, scoped auth and multi-packet replies", async () => {
    await httpFixture(
      (_request, response) => response.end(),
      async (origin, server) => {
        const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
        const observed = Promise.withResolvers<{
          text: string;
          binary: boolean;
          auth: string | undefined;
        }>();
        const completed = Promise.withResolvers<string>();
        const stopped = new AbortController();
        const receiver = new WsTextReceiver(RPC_MESSAGE_OBSERVATION_BYTES);
        const payload = "😀é漢".repeat(20_000);
        let bridge: RemoteWsBridge;
        const channel = {
          signal: stopped.signal,
          async send(envelope: TunnelEnvelope) {
            if (envelope.t === "error") completed.reject(new Error(envelope.reason));
            if (envelope.t === "ws.msg") {
              const message = receiver.accept(envelope);
              if (message !== undefined) completed.resolve(message);
            }
          },
        };
        server.on("upgrade", (request, socket, head) =>
          wss.handleUpgrade(request, socket, head, (ws) => {
            ws.on("message", (bytes, binary) => {
              observed.resolve({
                text: bytes.toString(),
                binary,
                auth: request.headers.authorization,
              });
              ws.send(payload);
            });
          }),
        );
        bridge = new RemoteWsBridge({
          origin,
          credential: "fixture-bearer",
          channel,
          observe: () => undefined,
        });
        try {
          await bridge.accept({ t: "ws.open", id: 1, path: "/ws/bootstrap" });
          for (const chunk of wsTextChunks({ id: 1, seq: 0, text: payload }))
            await bridge.accept(chunk);
          expect(await completed.promise).toBe(payload);
          expect(await observed.promise).toEqual({
            text: payload,
            binary: false,
            auth: "Bearer fixture-bearer",
          });
        } finally {
          stopped.abort();
          await bridge.close();
          receiver.close();
          for (const ws of wss.clients) ws.terminate();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        }
      },
    );
  });

  it("rejects forbidden paths before connecting", async () => {
    const sent: TunnelEnvelope[] = [];
    const bridge = new RemoteWsBridge({
      origin: "http://127.0.0.1:1",
      credential: "fixture",
      channel: {
        signal: new AbortController().signal,
        send: async (value) => {
          sent.push(value);
        },
      },
      observe: () => undefined,
    });
    try {
      await bridge.accept({ t: "ws.open", id: 1, path: "/api/auth" });
      expect(sent).toEqual([{ t: "error", id: 1, reason: "forbidden-path" }]);
    } finally {
      await bridge.close();
    }
  });
});

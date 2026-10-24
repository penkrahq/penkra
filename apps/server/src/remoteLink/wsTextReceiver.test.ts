import { describe, expect, it } from "vitest";
import { NoiseCipher } from "./noise";
import { TunnelChannel } from "./tunnelChannel";
import { RPC_MESSAGE_OBSERVATION_BYTES } from "../rpcMessageSizes";
import { wsTextChunks } from "./wsTextChunks";
import { WsTextReceiver } from "./wsTextReceiver";
import { TUNNEL_MAX_INFLIGHT_BYTES } from "./sendWindow";

describe("WebSocket text reassembly", () => {
  it("ACKs stored chunks and completes a message larger than the transit window", async () => {
    const key1 = new Uint8Array(32).fill(1),
      key2 = new Uint8Array(32).fill(2);
    const assembly = new WsTextReceiver(RPC_MESSAGE_OBSERVATION_BYTES);
    let received: string | undefined;
    let peer: TunnelChannel;
    const sender = new TunnelChannel(
      { send: new NoiseCipher(key1), receive: new NoiseCipher(key2) },
      async (bytes) => {
        const chunk = peer.receive(bytes);
        if (chunk?.t !== "ws.msg") throw new Error("Unexpected test message");
        const message = assembly.accept(chunk);
        await peer.send({ t: "ack", id: chunk.id, seq: chunk.seq });
        if (message !== undefined) received = message;
      },
    );
    peer = new TunnelChannel(
      { send: new NoiseCipher(key2), receive: new NoiseCipher(key1) },
      async (bytes) => {
        sender.receive(bytes);
      },
    );
    try {
      const text = "x".repeat(TUNNEL_MAX_INFLIGHT_BYTES + 1);
      for (const chunk of wsTextChunks({ id: 1, seq: 0, text })) await sender.send(chunk);
      expect(received).toBe(text);
      expect(sender.window.snapshot().bytes).toBe(0);
    } finally {
      assembly.close();
      sender.close();
      peer.close();
    }
  });
  it("bounds complete messages, resets after each message, and reports a typed overflow", () => {
    const receiver = new WsTextReceiver(4);
    expect(receiver.accept({ t: "ws.msg", id: 1, seq: 0, data: "é", more: true })).toBeUndefined();
    expect(receiver.accept({ t: "ws.msg", id: 1, seq: 1, data: "é" })).toBe("éé");
    expect(receiver.accept({ t: "ws.msg", id: 1, seq: 2, data: "test" })).toBe("test");
    expect(() => receiver.accept({ t: "ws.msg", id: 1, seq: 3, data: "too big" })).toThrow(
      expect.objectContaining({ code: "reply-too-large", bytes: 7, limit: 4 }),
    );
    expect(() => receiver.accept({ t: "ws.msg", id: 1, seq: 4, data: "" })).toThrow(
      "invalid-envelope",
    );
  });
});

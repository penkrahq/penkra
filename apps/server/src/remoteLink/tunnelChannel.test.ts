import { describe, expect, it } from "vitest";
import { NoiseCipher, NOISE_MAX_MESSAGE_BYTES } from "./noise";
import { TUNNEL_MAX_INFLIGHT_BYTES } from "./sendWindow";
import { TunnelChannel } from "./tunnelChannel";
import { encodeHttpBody, type TunnelEnvelope } from "./tunnelCodec";

async function* body() {
  for (let i = 0; i < 80; i++) yield Buffer.alloc(64 * 1024);
}

function ciphers() {
  const first = new Uint8Array(32).fill(1),
    second = new Uint8Array(32).fill(2);
  return [
    { send: new NoiseCipher(first), receive: new NoiseCipher(second) },
    { send: new NoiseCipher(second), receive: new NoiseCipher(first) },
  ] as const;
}

describe("RemoteLink ordered encrypted channel", () => {
  it("sends controls through a full data window and cancels a blocked send without consuming a nonce", async () => {
    const [left, right] = ciphers();
    const received: TunnelEnvelope[] = [];
    const receiver = new TunnelChannel(right, async () => undefined);
    const sender = new TunnelChannel(left, async (packet) => {
      received.push(receiver.receive(packet)!);
    });
    const abort = new AbortController();
    try {
      let remaining = TUNNEL_MAX_INFLIGHT_BYTES,
        seq = 0;
      while (remaining) {
        const bytes = Math.min(remaining, NOISE_MAX_MESSAGE_BYTES);
        (await sender.window.reserve({ id: 99, seq: seq++, bytes })).sent();
        remaining -= bytes;
      }
      const blocked = sender.send(
        { t: "http.body", id: 1, seq: 0, body: "YQ==", more: true },
        abort.signal,
      );
      expect(sender.window.snapshot().waiting).toBe(1);
      await sender.send({ t: "http.cancel", id: 2 });
      abort.abort();
      await expect(blocked).rejects.toMatchObject({ code: "cancelled" });
      await sender.send({ t: "http.cancel", id: 3 });
      expect(received).toEqual([
        { t: "http.cancel", id: 2 },
        { t: "http.cancel", id: 3 },
      ]);
      expect(sender.window.snapshot().waiting).toBe(0);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("transfers a multi-window body with real encryption and consumption ACKs", async () => {
    const [left, right] = ciphers();
    let received = 0,
      eof = false;
    let receiver: TunnelChannel;
    const sender = new TunnelChannel(left, async (packet) => {
      const envelope = receiver.receive(packet);
      if (envelope?.t !== "http.body") throw new Error("Unexpected envelope");
      received += Buffer.from(envelope.body, "base64").byteLength;
      eof = envelope.more === undefined;
      await receiver.send({ t: "ack", id: envelope.id, seq: envelope.seq });
    });
    receiver = new TunnelChannel(right, async (packet) => {
      sender.receive(packet);
    });
    try {
      for await (const packet of encodeHttpBody({ id: 1, body: body() }))
        await sender.send(packet.envelope);
      expect(received).toBe(5 * 1024 * 1024);
      expect(eof).toBe(true);
      expect(sender.window.snapshot().bytes).toBe(0);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("serializes concurrent writes so every packet remains decryptable", async () => {
    const [left, right] = ciphers();
    const received: TunnelEnvelope[] = [];
    const receiver = new TunnelChannel(right, async () => undefined);
    const sender = new TunnelChannel(left, async (packet) => {
      received.push(receiver.receive(packet)!);
    });
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => sender.send({ t: "http.cancel", id: index + 1 })),
      );
      expect(received.map((value) => ("id" in value ? value.id : null))).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it("closes both cipher directions after a failed encrypted write", async () => {
    const [left, right] = ciphers();
    const sender = new TunnelChannel(left, async () => {
      throw new Error("fixture disconnect");
    });
    await expect(sender.send({ t: "http.cancel", id: 1 })).rejects.toThrow("fixture disconnect");
    expect(sender.signal.aborted).toBe(true);
    expect(sender.window.snapshot().closed).toBe(true);
    await expect(sender.send({ t: "http.cancel", id: 2 })).rejects.toThrow("closed");
    expect(() => left.receive.decrypt(new Uint8Array(16))).toThrow("closed");
    right.send.destroy();
    right.receive.destroy();
  });

  it("rejects replayed packets and unknown ACKs by closing the session", async () => {
    for (const replay of [true, false]) {
      const [left, right] = ciphers();
      let wire: Uint8Array = new Uint8Array();
      const sender = new TunnelChannel(left, async (packet) => {
        wire = packet;
      });
      const receiver = new TunnelChannel(right, async () => undefined);
      try {
        await sender.send(replay ? { t: "http.cancel", id: 1 } : { t: "ack", id: 1, seq: 0 });
        if (replay) receiver.receive(wire);
        expect(() => receiver.receive(wire)).toThrow();
        expect(receiver.signal.aborted).toBe(true);
      } finally {
        sender.close();
        receiver.close();
      }
    }
  });
});

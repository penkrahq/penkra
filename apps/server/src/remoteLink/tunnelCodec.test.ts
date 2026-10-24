import { describe, expect, it } from "vitest";
import { NoiseCipher, NOISE_MAX_MESSAGE_BYTES } from "./noise";
import { decodeTunnelEnvelope, encodeTunnelEnvelope, encodeHttpBody } from "./tunnelCodec";

function raw(value: unknown) {
  const json = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + json.length);
  frame.writeUInt32BE(json.length);
  json.copy(frame, 4);
  return frame;
}

describe("RemoteLink encrypted envelope codec", () => {
  it("round trips controls and rejects unknown fields rather than stripping them", () => {
    for (const envelope of [
      { t: "ack", id: 1, seq: 0 },
      { t: "http.cancel", id: 1 },
      { t: "viewing", threadId: null },
    ] as const) {
      expect(decodeTunnelEnvelope(encodeTunnelEnvelope(envelope))).toEqual(envelope);
    }
    for (const value of [
      { t: "ack", id: 1, seq: 0, token: "forbidden" },
      { t: "ack", id: Number.MAX_SAFE_INTEGER + 1, seq: 0 },
      { t: "ack", id: 1, seq: -1 },
      { t: "http.body", id: 1, seq: 0, body: "not base64!" },
      { t: "http.body", id: 1, seq: 0, body: "YQ" },
      { t: "http.body", id: 1, seq: 0, body: "", more: false },
      { t: "unrecognized" },
    ])
      expect(() => decodeTunnelEnvelope(raw(value))).toThrow("invalid-envelope");
  });

  it("rejects corrupt framing, trailing data, invalid UTF-8 and oversize plaintext", () => {
    const valid = Buffer.from(encodeTunnelEnvelope({ t: "ack", id: 1, seq: 0 }));
    for (const bytes of [
      valid.subarray(0, 3),
      valid.subarray(0, valid.length - 1),
      Buffer.concat([valid, valid]),
      Buffer.from([0, 0, 0, 1, 255]),
    ]) {
      expect(() => decodeTunnelEnvelope(bytes)).toThrow("invalid-envelope");
    }
    expect(() => decodeTunnelEnvelope(Buffer.alloc(NOISE_MAX_MESSAGE_BYTES))).toThrow(
      "oversized-envelope",
    );
    expect(() =>
      encodeTunnelEnvelope({
        t: "ws.msg",
        id: 1,
        seq: 0,
        data: "😀".repeat(NOISE_MAX_MESSAGE_BYTES),
      }),
    ).toThrow("oversized-envelope");
  });

  it("chunks lazily with exact encrypted size, sequence and explicit streaming EOF", async () => {
    const original = Buffer.alloc(256 * 1024, 191);
    let pulled = 0;
    async function* source() {
      pulled++;
      yield original;
      pulled++;
      yield Buffer.from("tail");
    }
    const encoder = encodeHttpBody({ id: Number.MAX_SAFE_INTEGER, body: source() });
    expect(pulled).toBe(0);
    const first = await encoder.next();
    expect(pulled).toBe(1);
    const packets = [first.value!];
    for await (const packet of encoder) packets.push(packet);
    const cipher = new NoiseCipher(new Uint8Array(32).fill(1));
    try {
      for (const [seq, packet] of packets.entries()) {
        expect(packet.envelope.seq).toBe(seq);
        expect(decodeTunnelEnvelope(packet.plaintext)).toEqual(packet.envelope);
        expect(cipher.encrypt(packet.plaintext).byteLength).toBeLessThanOrEqual(
          NOISE_MAX_MESSAGE_BYTES,
        );
      }
      expect(packets.at(-1)?.envelope).toEqual({
        t: "http.body",
        id: Number.MAX_SAFE_INTEGER,
        seq: packets.length - 1,
        body: "",
      });
      expect(Buffer.concat(packets.map((p) => Buffer.from(p.envelope.body, "base64")))).toEqual(
        Buffer.concat([original, Buffer.from("tail")]),
      );
      expect(packets[0]!.plaintext.byteLength + 16).toBeGreaterThan(NOISE_MAX_MESSAGE_BYTES - 4);
    } finally {
      cipher.destroy();
    }
  });
});

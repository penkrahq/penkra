import { describe, expect, it } from "vitest";
import vectors from "./fixtures/cacophony.json";
import {
  createNoiseIdentity,
  NoiseCipher,
  NoiseHandshake,
  noisePairingCode,
  noisePublicKey,
} from "./noise";

const hex = (value: string) => Buffer.from(value, "hex");
const bytes = (value: Uint8Array) => Buffer.from(value).toString("hex");

describe("Noise published vectors", () => {
  it.each(vectors)("matches $protocol_name byte for byte", (vector) => {
    const pattern = vector.protocol_name.includes("_XX_") ? "XX" : "KK";
    const handshakeLength = pattern === "XX" ? 3 : 2;
    const initiator = new NoiseHandshake({
      pattern,
      initiator: true,
      staticPrivateKey: hex(vector.init_static),
      ephemeralPrivateKey: hex(vector.init_ephemeral),
      prologue: hex(vector.init_prologue),
      ...(vector.init_remote_static ? { remoteStaticKey: hex(vector.init_remote_static) } : {}),
    });
    const responder = new NoiseHandshake({
      pattern,
      initiator: false,
      staticPrivateKey: hex(vector.resp_static),
      ephemeralPrivateKey: hex(vector.resp_ephemeral),
      prologue: hex(vector.resp_prologue),
      ...(vector.resp_remote_static ? { remoteStaticKey: hex(vector.resp_remote_static) } : {}),
    });
    for (const [index, message] of vector.messages.entries()) {
      const sender = index % 2 === 0 ? initiator : responder;
      const receiver = index % 2 === 0 ? responder : initiator;
      const ciphertext =
        index < handshakeLength
          ? sender.writeMessage(hex(message.payload))
          : sender.finish().send.encrypt(hex(message.payload));
      expect(bytes(ciphertext)).toBe(message.ciphertext);
      const plaintext =
        index < handshakeLength
          ? receiver.readMessage(ciphertext)
          : receiver.finish().receive.decrypt(ciphertext);
      expect(bytes(plaintext)).toBe(message.payload);
    }
    expect(bytes(initiator.finish().handshakeHash)).toBe(vector.handshake_hash);
    expect(bytes(responder.finish().handshakeHash)).toBe(vector.handshake_hash);
    expect(noisePairingCode(initiator.finish().handshakeHash)).toBe(
      noisePairingCode(responder.finish().handshakeHash),
    );
  });
});

describe("Noise failures and lifecycle", () => {
  const pair = () => {
    const alice = new NoiseHandshake({
      pattern: "XX",
      initiator: true,
      staticPrivateKey: createNoiseIdentity(),
      prologue: hex("0102"),
    });
    const bob = new NoiseHandshake({
      pattern: "XX",
      initiator: false,
      staticPrivateKey: createNoiseIdentity(),
      prologue: hex("0102"),
    });
    bob.readMessage(alice.writeMessage());
    alice.readMessage(bob.writeMessage());
    bob.readMessage(alice.writeMessage());
    return { alice, bob };
  };
  it("refuses replays and closes a cipher after authentication fails", () => {
    const { alice, bob } = pair();
    const ciphertext = alice.finish().send.encrypt(hex("aabb"));
    expect(bytes(bob.finish().receive.decrypt(ciphertext))).toBe("aabb");
    expect(() => bob.finish().receive.decrypt(ciphertext)).toThrow();
    expect(() => bob.finish().receive.decrypt(alice.finish().send.encrypt(hex("cc")))).toThrow(
      "closed",
    );
  });
  it("authenticates the prologue and refuses an incorrect known static key", () => {
    const aliceKey = createNoiseIdentity(),
      bobKey = createNoiseIdentity();
    const alice = new NoiseHandshake({
      pattern: "KK",
      initiator: true,
      staticPrivateKey: aliceKey,
      remoteStaticKey: noisePublicKey(bobKey),
      prologue: hex("01"),
    });
    const bob = new NoiseHandshake({
      pattern: "KK",
      initiator: false,
      staticPrivateKey: bobKey,
      remoteStaticKey: noisePublicKey(aliceKey),
      prologue: hex("02"),
    });
    expect(() => bob.readMessage(alice.writeMessage())).toThrow();
    const wrong = new NoiseHandshake({
      pattern: "KK",
      initiator: false,
      staticPrivateKey: createNoiseIdentity(),
      remoteStaticKey: noisePublicKey(aliceKey),
      prologue: hex("01"),
    });
    const retry = new NoiseHandshake({
      pattern: "KK",
      initiator: true,
      staticPrivateKey: aliceKey,
      remoteStaticKey: noisePublicKey(bobKey),
      prologue: hex("01"),
    });
    expect(() => wrong.readMessage(retry.writeMessage())).toThrow();
  });
  it("never resets transport nonces when finish is read again", () => {
    const { alice, bob } = pair();
    const transport = alice.finish();
    expect(alice.finish()).toBe(transport);
    const first = transport.send.encrypt(hex("aa"));
    const second = alice.finish().send.encrypt(hex("aa"));
    expect(bytes(first)).not.toBe(bytes(second));
    expect(bytes(bob.finish().receive.decrypt(first))).toBe("aa");
    expect(bytes(bob.finish().receive.decrypt(second))).toBe("aa");
    alice.destroy();
    expect(() => transport.send.encrypt(hex("aa"))).toThrow("closed");
  });
  it("enforces size limits, handshake order and low-order public-key rejection", () => {
    const alice = new NoiseHandshake({
      pattern: "XX",
      initiator: true,
      staticPrivateKey: createNoiseIdentity(),
      prologue: hex(""),
    });
    expect(() => alice.finish()).toThrow();
    expect(() => alice.readMessage(hex(""))).toThrow();
    const bob = new NoiseHandshake({
      pattern: "XX",
      initiator: false,
      staticPrivateKey: createNoiseIdentity(),
      prologue: hex(""),
    });
    expect(() => bob.readMessage(new Uint8Array(31))).toThrow();
    const low = new NoiseHandshake({
      pattern: "XX",
      initiator: false,
      staticPrivateKey: createNoiseIdentity(),
      prologue: hex(""),
    });
    low.readMessage(new Uint8Array(32));
    expect(() => low.writeMessage()).toThrow();
    const { alice: active } = pair();
    expect(active.finish().send.encrypt(new Uint8Array(65_519))).toHaveLength(65_535);
    expect(() => active.finish().send.encrypt(new Uint8Array(65_520))).toThrow();
  });
  it("supports explicit Noise rekey without resetting the running nonce", () => {
    const key = createNoiseIdentity(),
      sender = new NoiseCipher(key),
      receiver = new NoiseCipher(key);
    expect(bytes(receiver.decrypt(sender.encrypt(hex("01"))))).toBe("01");
    sender.rekey();
    receiver.rekey();
    expect(bytes(receiver.decrypt(sender.encrypt(hex("02"))))).toBe("02");
  });
});

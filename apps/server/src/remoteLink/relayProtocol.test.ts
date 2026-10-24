import { describe, expect, it } from "vitest";
import { NOISE_MAX_MESSAGE_BYTES } from "./noise";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  RELAY_MAX_FRAME_BYTES,
  RELAY_ZERO_ID,
  RelayFrameType,
  RelayOpenMode,
} from "./relayProtocol";

const sessionId = "00112233-4455-6677-8899-aabbccddeeff";
const peerId = "ffeeddcc-bbaa-9988-7766-554433221100";
// Fixed bytes from the relay v1 field layout, independent of this codec.
const header = "010100112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";

describe("relay v1 wire contract", () => {
  it.each([RelayOpenMode.PAIRING, RelayOpenMode.SESSION])(
    "encodes the explicit OPEN mode %s",
    (mode) => {
      const bytes = Buffer.from(header + `0${mode}010203`, "hex");
      const frame = {
        type: RelayFrameType.OPEN,
        mode,
        sessionId,
        peerId,
        payload: Uint8Array.of(1, 2, 3),
      };
      expect(encodeRelayFrame(frame)).toEqual(bytes);
      expect(decodeRelayFrame(bytes)).toEqual({ ...frame, payload: Buffer.from([1, 2, 3]) });
    },
  );
  it.each([
    RelayFrameType.DATA,
    RelayFrameType.CLOSE,
    RelayFrameType.PRESENCE,
    RelayFrameType.ERROR,
    RelayFrameType.SLEEP,
  ])("round trips type %s without a mode byte", (type) => {
    const frame = { type, sessionId: RELAY_ZERO_ID, peerId, payload: Buffer.from([0, 255]) };
    expect(encodeRelayFrame(frame).byteLength).toBe(36);
    expect(decodeRelayFrame(encodeRelayFrame(frame))).toEqual(frame);
  });
  it("accepts a maximum Noise OPEN and rejects one extra byte", () => {
    const frame = {
      type: RelayFrameType.OPEN,
      mode: RelayOpenMode.SESSION,
      sessionId,
      peerId,
      payload: new Uint8Array(NOISE_MAX_MESSAGE_BYTES),
    };
    const bytes = encodeRelayFrame(frame);
    expect(bytes.byteLength).toBe(RELAY_MAX_FRAME_BYTES);
    expect(decodeRelayFrame(bytes).payload.byteLength).toBe(NOISE_MAX_MESSAGE_BYTES);
    expect(() =>
      encodeRelayFrame({ ...frame, payload: new Uint8Array(NOISE_MAX_MESSAGE_BYTES + 1) }),
    ).toThrow();
    expect(() => decodeRelayFrame(Buffer.concat([bytes, Buffer.of(0)]))).toThrow();
  });
  it("rejects missing/unknown OPEN modes, unknown versions and invalid identifiers", () => {
    for (const suffix of ["", "00", "03"])
      expect(() => decodeRelayFrame(Buffer.from(header + suffix, "hex"))).toThrow();
    const bytes = Buffer.from(header + "01", "hex");
    bytes[0] = 2;
    expect(() => decodeRelayFrame(bytes)).toThrow();
    expect(() =>
      encodeRelayFrame({
        type: RelayFrameType.DATA,
        sessionId: "not-a-uuid",
        peerId,
        payload: new Uint8Array(),
      }),
    ).toThrow();
    expect(() =>
      encodeRelayFrame({
        type: RelayFrameType.DATA,
        mode: RelayOpenMode.SESSION,
        sessionId,
        peerId,
        payload: new Uint8Array(),
      }),
    ).toThrow();
  });
});

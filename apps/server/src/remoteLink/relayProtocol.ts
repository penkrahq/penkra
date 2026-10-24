import { NOISE_MAX_MESSAGE_BYTES } from "./noise";

// Relay v1 contract: TODO §7.2.5 and penkra-backend apps/relay/src/protocol.ts.
export const RELAY_VERSION = 1;
export const RELAY_ZERO_ID = "00000000-0000-0000-0000-000000000000";
export const RELAY_HEADER_BYTES = 34;
export const RELAY_MAX_FRAME_BYTES = RELAY_HEADER_BYTES + 1 + NOISE_MAX_MESSAGE_BYTES;

export enum RelayFrameType {
  OPEN = 1,
  DATA,
  CLOSE,
  PRESENCE,
  ERROR,
  SLEEP,
}
export enum RelayOpenMode {
  PAIRING = 1,
  SESSION = 2,
}

export interface RelayFrame {
  readonly type: RelayFrameType;
  readonly sessionId: string;
  readonly peerId: string;
  readonly payload: Uint8Array;
  readonly mode?: RelayOpenMode;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function encodeId(id: string) {
  if (!UUID.test(id)) throw new Error("Invalid relay identifier.");
  return Buffer.from(id.replaceAll("-", ""), "hex");
}
function decodeId(bytes: Buffer) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeRelayFrame(frame: RelayFrame): Buffer {
  const open = frame.type === RelayFrameType.OPEN;
  if (
    !Number.isInteger(frame.type) ||
    frame.type < RelayFrameType.OPEN ||
    frame.type > RelayFrameType.SLEEP ||
    frame.payload.byteLength > NOISE_MAX_MESSAGE_BYTES ||
    (open
      ? frame.mode !== RelayOpenMode.PAIRING && frame.mode !== RelayOpenMode.SESSION
      : frame.mode !== undefined)
  ) {
    throw new Error("Invalid relay frame.");
  }
  return Buffer.concat([
    Buffer.from([RELAY_VERSION, frame.type]),
    encodeId(frame.sessionId),
    encodeId(frame.peerId),
    ...(open ? [Buffer.from([frame.mode!])] : []),
    frame.payload,
  ]);
}

export function decodeRelayFrame(input: Uint8Array): RelayFrame {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (
    data.byteLength < RELAY_HEADER_BYTES ||
    data[0] !== RELAY_VERSION ||
    data[1]! < RelayFrameType.OPEN ||
    data[1]! > RelayFrameType.SLEEP
  )
    throw new Error("Invalid relay frame.");
  const open = data[1] === RelayFrameType.OPEN;
  const offset = RELAY_HEADER_BYTES + (open ? 1 : 0);
  if (
    data.byteLength < offset ||
    data.byteLength - offset > NOISE_MAX_MESSAGE_BYTES ||
    (open &&
      data[RELAY_HEADER_BYTES] !== RelayOpenMode.PAIRING &&
      data[RELAY_HEADER_BYTES] !== RelayOpenMode.SESSION)
  ) {
    throw new Error("Invalid relay frame.");
  }
  return {
    type: data[1]!,
    sessionId: decodeId(data.subarray(2, 18)),
    peerId: decodeId(data.subarray(18, 34)),
    payload: data.subarray(offset),
    ...(open ? { mode: data[RELAY_HEADER_BYTES] as RelayOpenMode } : {}),
  };
}

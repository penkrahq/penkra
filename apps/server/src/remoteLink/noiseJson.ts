import { NOISE_MAX_MESSAGE_BYTES } from "./noise";

const TAG_BYTES = 16;
const PREFIX_BYTES = 4;
const MAX_PLAINTEXT = NOISE_MAX_MESSAGE_BYTES - TAG_BYTES;
const utf8 = new TextDecoder("utf-8", { fatal: true });
export class NoiseJsonError extends Error {
  constructor(readonly code: "invalid-json" | "oversized-json") {
    super(`RemoteLink JSON: ${code}.`);
  }
}
/** One network-order uint32 byte length and UTF-8 JSON value per Noise message. */
export function encodeNoiseJson(value: unknown): Uint8Array {
  let json: Buffer;
  try {
    json = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw new NoiseJsonError("invalid-json");
  }
  if (json.length + PREFIX_BYTES > MAX_PLAINTEXT) throw new NoiseJsonError("oversized-json");
  const bytes = Buffer.allocUnsafe(PREFIX_BYTES + json.length);
  bytes.writeUInt32BE(json.length);
  json.copy(bytes, PREFIX_BYTES);
  return bytes;
}
export function decodeNoiseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_PLAINTEXT) throw new NoiseJsonError("oversized-json");
  try {
    if (bytes.byteLength < PREFIX_BYTES) throw new Error();
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.readUInt32BE() !== view.length - PREFIX_BYTES) throw new Error();
    return JSON.parse(utf8.decode(view.subarray(PREFIX_BYTES)));
  } catch {
    throw new NoiseJsonError("invalid-json");
  }
}
/** Remaining JSON-safe ASCII payload bytes after this envelope's exact framing. */
export function noiseJsonRemainingBytes(value: unknown): number {
  return MAX_PLAINTEXT - encodeNoiseJson(value).byteLength;
}

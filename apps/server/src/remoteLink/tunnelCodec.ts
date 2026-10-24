import { Schema } from "effect";
import { NOISE_MAX_MESSAGE_BYTES } from "./noise";

const Id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const More = Schema.optional(Schema.Literal(true));
const Envelope = Schema.Union([
  Schema.Struct({
    t: Schema.Literal("http"),
    id: Id,
    method: Schema.Literals(["GET", "POST"]),
    path: Schema.String,
    contentType: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    t: Schema.Literal("http.res"),
    id: Id,
    status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    t: Schema.Literal("http.body"),
    id: Id,
    seq: Seq,
    body: Schema.String,
    more: More,
  }),
  Schema.Struct({ t: Schema.Literal("http.cancel"), id: Id }),
  Schema.Struct({ t: Schema.Literal("ack"), id: Id, seq: Seq }),
  Schema.Struct({ t: Schema.Literal("ws.open"), id: Id, path: Schema.String }),
  Schema.Struct({ t: Schema.Literal("ws.msg"), id: Id, seq: Seq, data: Schema.String, more: More }),
  Schema.Struct({ t: Schema.Literal("ws.close"), id: Id, code: Schema.Int }),
  Schema.Struct({ t: Schema.Literal("viewing"), threadId: Schema.NullOr(Schema.String) }),
  Schema.Struct({ t: Schema.Literal("error"), id: Id, reason: Schema.String }),
]);
export type TunnelEnvelope = typeof Envelope.Type;
export type HttpBodyChunk = Extract<TunnelEnvelope, { t: "http.body" }>;
const validate = Schema.decodeUnknownSync(Envelope);
const TAG_BYTES = 16; // ChaChaPoly authentication tag.
const PREFIX_BYTES = 4; // Network-order uint32 JSON byte length, inside Noise.
const MAX_PLAINTEXT = NOISE_MAX_MESSAGE_BYTES - TAG_BYTES;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class TunnelCodecError extends Error {
  constructor(readonly code: "invalid-envelope" | "oversized-envelope") {
    super(`RemoteLink tunnel: ${code}.`);
    this.name = "TunnelCodecError";
  }
}

function checked(value: unknown): TunnelEnvelope {
  try {
    const envelope = validate(value, { onExcessProperty: "error" });
    if ("id" in envelope && !Number.isSafeInteger(envelope.id)) throw new Error();
    if ("seq" in envelope && !Number.isSafeInteger(envelope.seq)) throw new Error();
    if (envelope.t === "http.body") {
      // Node's base64 decoder otherwise silently accepts invalid/noncanonical input.
      if (Buffer.from(envelope.body, "base64").toString("base64") !== envelope.body)
        throw new Error();
    }
    return envelope;
  } catch {
    throw new TunnelCodecError("invalid-envelope");
  }
}

/** Exactly one length-prefixed JSON envelope per Noise transport message. */
export function encodeTunnelEnvelope(value: TunnelEnvelope): Uint8Array {
  const json = Buffer.from(JSON.stringify(checked(value)), "utf8");
  if (json.length + PREFIX_BYTES > MAX_PLAINTEXT) throw new TunnelCodecError("oversized-envelope");
  const bytes = Buffer.allocUnsafe(PREFIX_BYTES + json.length);
  bytes.writeUInt32BE(json.length);
  json.copy(bytes, PREFIX_BYTES);
  return bytes;
}

export function decodeTunnelEnvelope(bytes: Uint8Array): TunnelEnvelope {
  if (bytes.byteLength > MAX_PLAINTEXT) throw new TunnelCodecError("oversized-envelope");
  try {
    if (bytes.byteLength < PREFIX_BYTES) throw new Error();
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.readUInt32BE() !== view.length - PREFIX_BYTES) throw new Error();
    return checked(JSON.parse(utf8.decode(view.subarray(PREFIX_BYTES))));
  } catch {
    throw new TunnelCodecError("invalid-envelope");
  }
}

/** Lazily yields bounded packets. JSON/base64 overhead is measured, not estimated.
 * EOF is a final empty chunk; no lookahead or whole-file buffer is needed.
 */
export async function* encodeHttpBody(input: {
  id: number;
  body: AsyncIterable<Uint8Array>;
}): AsyncGenerator<{ envelope: HttpBodyChunk; plaintext: Uint8Array }> {
  let seq = 0;
  for await (const part of input.body) {
    let offset = 0;
    while (offset < part.byteLength) {
      const empty: HttpBodyChunk = { t: "http.body", id: input.id, seq, body: "", more: true };
      const overhead = Buffer.byteLength(JSON.stringify(empty)) + PREFIX_BYTES;
      // Base64 is exactly four JSON-safe ASCII bytes per three input bytes.
      const capacity = Math.floor((MAX_PLAINTEXT - overhead) / 4) * 3;
      const fit = Math.min(part.byteLength - offset, capacity);
      if (!fit) throw new TunnelCodecError("oversized-envelope");
      const envelope: HttpBodyChunk = {
        t: "http.body",
        id: input.id,
        seq,
        body: Buffer.from(part.subarray(offset, offset + fit)).toString("base64"),
        more: true,
      };
      yield { envelope, plaintext: encodeTunnelEnvelope(envelope) };
      offset += fit;
      seq++;
    }
  }
  const envelope: HttpBodyChunk = { t: "http.body", id: input.id, seq, body: "" };
  yield { envelope, plaintext: encodeTunnelEnvelope(envelope) };
}

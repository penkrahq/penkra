import { NOISE_MAX_MESSAGE_BYTES } from "./noise";
import { encodeTunnelEnvelope, TunnelCodecError, type TunnelEnvelope } from "./tunnelCodec";

type TextChunk = Extract<TunnelEnvelope, { t: "ws.msg" }>;

/** Chunk a complete WebSocket text message without splitting Unicode scalars.
 * The sequence belongs to the socket, so a subsequent message continues it.
 * JSON escaping is counted exactly; a small raw text chunk can expand sixfold.
 */
export function* wsTextChunks(input: {
  id: number;
  seq: number;
  text: string;
}): Generator<TextChunk> {
  let offset = 0,
    seq = input.seq;
  do {
    const empty: TextChunk = { t: "ws.msg", id: input.id, seq, data: "", more: true };
    // Prefix and ChaChaPoly tag are protocol widths, not application budgets.
    const capacity = NOISE_MAX_MESSAGE_BYTES - 16 - 4 - Buffer.byteLength(JSON.stringify(empty));
    const start = offset;
    let bytes = 0;
    while (offset < input.text.length) {
      const code = input.text.codePointAt(offset)!;
      if (code >= 0xd800 && code <= 0xdfff) throw new TunnelCodecError("invalid-envelope");
      const escaped =
        code === 34 || code === 92
          ? 2
          : code < 32
            ? [8, 9, 10, 12, 13].includes(code)
              ? 2
              : 6
            : code < 0x80
              ? 1
              : code < 0x800
                ? 2
                : code < 0x10000
                  ? 3
                  : 4;
      if (bytes + escaped > capacity) break;
      bytes += escaped;
      offset += code > 0xffff ? 2 : 1;
    }
    if (offset === start && offset < input.text.length)
      throw new TunnelCodecError("oversized-envelope");
    const value: TextChunk = {
      t: "ws.msg",
      id: input.id,
      seq,
      data: input.text.slice(start, offset),
      ...(offset < input.text.length ? { more: true } : {}),
    };
    // The encoder remains the authoritative final check of the exact wire size.
    encodeTunnelEnvelope(value);
    yield value;
    seq++;
  } while (offset < input.text.length);
}

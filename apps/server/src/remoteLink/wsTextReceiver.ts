import { TunnelCodecError, type TunnelEnvelope } from "./tunnelCodec";

/** One ordered message at a time per WebSocket stream, not per Noise packet.
 * The caller ACKs a chunk after accept returns. A size failure affects this
 * stream; the owning transport is responsible for failing its pending RPCs.
 */
export class WsTextReceiver {
  #seq = 0;
  #bytes = 0;
  #parts: string[] = [];
  #failed = false;
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid RPC receive limit.");
  }
  accept(chunk: Extract<TunnelEnvelope, { t: "ws.msg" }>): string | undefined {
    if (this.#failed || chunk.seq !== this.#seq) {
      this.close();
      throw new TunnelCodecError("invalid-envelope");
    }
    const bytes = this.#bytes + Buffer.byteLength(chunk.data, "utf8");
    if (bytes > this.limit) {
      this.close();
      throw new RpcReplyTooLarge(bytes, this.limit);
    }
    this.#seq++;
    this.#bytes = bytes;
    if (chunk.data.length) this.#parts.push(chunk.data);
    if (chunk.more) return;
    const message = this.#parts.join("");
    this.#parts = [];
    this.#bytes = 0;
    return message;
  }
  close() {
    this.#parts = [];
    this.#bytes = 0;
    this.#failed = true;
  }
}

export class RpcReplyTooLarge extends Error {
  readonly code = "reply-too-large";
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`RPC reply is too large (${bytes} bytes; limit ${limit}).`);
    this.name = "RpcReplyTooLarge";
  }
}

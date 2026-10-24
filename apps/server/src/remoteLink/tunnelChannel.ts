import type { NoiseTransport } from "./noise";
import { TunnelSendWindow } from "./sendWindow";
import { decodeTunnelEnvelope, encodeTunnelEnvelope, type TunnelEnvelope } from "./tunnelCodec";

/** One ordered cipher pair and flow window per phone session. The relay owns framing;
 * sendWire must resolve only when its WebSocket write completes, not enqueue elsewhere.
 */
export class TunnelChannel {
  readonly window = new TunnelSendWindow();
  readonly #stopped = new AbortController();
  #writer: Promise<void> = Promise.resolve();
  constructor(
    private readonly transport: Pick<NoiseTransport, "send" | "receive">,
    private readonly sendWire: (ciphertext: Uint8Array) => Promise<void>,
  ) {}

  get signal() {
    return this.#stopped.signal;
  }

  async send(envelope: TunnelEnvelope, signal?: AbortSignal): Promise<void> {
    if (this.signal.aborted) throw new Error("RemoteLink tunnel is closed.");
    const plaintext = encodeTunnelEnvelope(envelope);
    const combined = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
    // Acquire capacity BEFORE entering the cipher writer. ACK/control messages
    // must still get through when both peers have filled their data windows.
    const lease =
      envelope.t === "http.body" || envelope.t === "ws.msg"
        ? await this.window.reserve(
            { id: envelope.id, seq: envelope.seq, bytes: plaintext.byteLength + 16 },
            combined,
          )
        : undefined;
    const writing = this.#writer.then(async () => {
      if (combined.aborted) {
        lease?.cancel();
        throw new Error("RemoteLink send cancelled.");
      }
      // Once encrypted, a failed write closes this entire cipher pair. Skipping
      // its nonce and continuing would make every later packet undecryptable.
      try {
        const ciphertext = this.transport.send.encrypt(plaintext);
        lease?.sent();
        await this.sendWire(ciphertext);
      } catch (error) {
        this.close();
        throw error;
      }
    });
    this.#writer = writing.catch(() => undefined);
    await writing;
  }

  /** Call in relay arrival order. The caller ACKs data only after consuming it. */
  receive(ciphertext: Uint8Array): TunnelEnvelope | undefined {
    if (this.signal.aborted) throw new Error("RemoteLink tunnel is closed.");
    try {
      const envelope = decodeTunnelEnvelope(this.transport.receive.decrypt(ciphertext));
      if (envelope.t === "ack") {
        this.window.acknowledge(envelope.id, envelope.seq);
        return;
      }
      return envelope;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    if (this.signal.aborted) return;
    this.#stopped.abort();
    this.window.close();
    this.transport.send.destroy();
    this.transport.receive.destroy();
  }
}

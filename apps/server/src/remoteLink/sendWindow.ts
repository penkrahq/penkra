import { NOISE_MAX_MESSAGE_BYTES } from "./noise";

// Approved tunnel flow window, not an attachment-size limit (TODO §7.5).
export const TUNNEL_MAX_INFLIGHT_BYTES = 4 * 1024 * 1024;

export class TunnelFlowError extends Error {
  constructor(
    readonly code: "closed" | "cancelled" | "invalid-chunk" | "invalid-state" | "unknown-ack",
  ) {
    super(`Tunnel flow control: ${code}.`);
    this.name = "TunnelFlowError";
  }
}
interface Entry {
  readonly bytes: number;
  state: "waiting" | "reserved" | "sent";
}
export interface TunnelChunkReservation {
  /** Call synchronously with dispatch, before awaiting any transport callback. */
  sent(): void;
  /** Only before encryption/dispatch; an encrypted but unsent packet requires closing Noise. */
  cancel(): void;
}

/** Pull-based sources await each reservation. This window never owns/queues payload buffers.
 * Reserve before acquiring the Noise writer. Consumption ACKs bypass the data window so a
 * full bidirectional window cannot prevent either peer from acknowledging received data.
 */
export class TunnelSendWindow {
  #entries = new Map<string, Entry>();
  #waiters = new Set<(error?: TunnelFlowError) => void>();
  #bytes = 0;
  #closed = false;

  snapshot() {
    return {
      bytes: this.#bytes,
      chunks: [...this.#entries.values()].filter((entry) => entry.state !== "waiting").length,
      waiting: this.#waiters.size,
      closed: this.#closed,
    };
  }

  async reserve(
    input: { id: number; seq: number; bytes: number },
    signal?: AbortSignal,
  ): Promise<TunnelChunkReservation> {
    if (
      !Number.isSafeInteger(input.id) ||
      input.id < 1 ||
      !Number.isSafeInteger(input.seq) ||
      input.seq < 0 ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > NOISE_MAX_MESSAGE_BYTES
    )
      throw new TunnelFlowError("invalid-chunk");
    const key = `${input.id}:${input.seq}`;
    if (this.#entries.has(key)) throw new TunnelFlowError("invalid-state");
    const entry: Entry = { bytes: input.bytes, state: "waiting" };
    this.#entries.set(key, entry);
    try {
      for (;;) {
        if (this.#closed) throw new TunnelFlowError("closed");
        if (signal?.aborted) throw new TunnelFlowError("cancelled");
        if (this.#bytes + entry.bytes <= TUNNEL_MAX_INFLIGHT_BYTES) break;
        await this.#wait(signal);
      }
      this.#bytes += entry.bytes;
      entry.state = "reserved";
    } catch (error) {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw error;
    }
    const assertReserved = () => {
      if (this.#closed) throw new TunnelFlowError("closed");
      if (this.#entries.get(key) !== entry || entry.state !== "reserved")
        throw new TunnelFlowError("invalid-state");
    };
    return {
      sent: () => {
        assertReserved();
        entry.state = "sent";
      },
      cancel: () => {
        assertReserved();
        this.#release(key, entry);
      },
    };
  }

  acknowledge(id: number, seq: number) {
    if (this.#closed) throw new TunnelFlowError("closed");
    const key = `${id}:${seq}`;
    const entry = this.#entries.get(key);
    if (!entry || entry.state !== "sent") throw new TunnelFlowError("unknown-ack");
    this.#release(key, entry);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#bytes = 0;
    this.#entries.clear();
    for (const wake of this.#waiters) wake(new TunnelFlowError("closed"));
  }

  #release(key: string, entry: Entry) {
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    for (const wake of this.#waiters) wake();
  }

  #wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = (error?: TunnelFlowError) => {
        this.#waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => wake(new TunnelFlowError("cancelled"));
      this.#waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

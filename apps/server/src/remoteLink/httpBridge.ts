import { LoopbackHttpError, openLoopbackHttp, type LoopbackHttpTransfer } from "./loopbackHttp";
import { TunnelPathError } from "./tunnelPaths";
import { encodeHttpBody, type TunnelEnvelope, type HttpBodyChunk } from "./tunnelCodec";
import type { TunnelChannel } from "./tunnelChannel";

type HttpRequest = Extract<TunnelEnvelope, { t: "http" }>;
type HttpInput = HttpRequest | HttpBodyChunk | Extract<TunnelEnvelope, { t: "http.cancel" }>;
interface Transfer {
  readonly http: LoopbackHttpTransfer;
  next: number;
  uploadEnded: boolean;
  responseStarted: boolean;
  responseEnded: boolean;
  cancelled: boolean;
  writes: Promise<void>;
}

/** Owns only the HTTP requests of one paired phone. Relay arrival order must be
 * preserved when calling accept, but its promises MUST NOT block dispatch of
 * unrelated requests or channel ACKs. Per-request writes serialize independently.
 */
export class RemoteHttpBridge {
  readonly #requests = new Map<number, Transfer>();
  readonly #tasks = new Set<Promise<void>>();
  #closed = false;
  constructor(
    private readonly input: {
      origin: string;
      credential: string;
      channel: Pick<TunnelChannel, "send" | "signal">;
      observe: (event: {
        id: number;
        event: "opened" | "upload" | "download" | "response-sent" | "cancelled" | "failed";
        bytes?: number;
      }) => void;
    },
  ) {}

  accept(envelope: HttpInput): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("RemoteLink HTTP bridge is closed."));
    if (envelope.t === "http") return this.#open(envelope);
    const state = this.#requests.get(envelope.id);
    // Cancellation is idempotent and can race a completed response.
    if (envelope.t === "http.cancel") {
      if (state) {
        state.cancelled = true;
        state.http.close();
        this.#requests.delete(envelope.id);
        this.input.observe({ id: envelope.id, event: "cancelled" });
      }
      return Promise.resolve();
    }
    if (!state || state.uploadEnded || state.next !== envelope.seq)
      return this.#error(envelope.id, "invalid-http-sequence");
    state.next++;
    if (envelope.more === undefined) state.uploadEnded = true;
    const writing = state.writes
      .then(async () => {
        if (!state.cancelled && !state.responseStarted) {
          const bytes = Buffer.from(envelope.body, "base64");
          if (bytes.byteLength) await state.http.write(bytes);
          if (envelope.more === undefined) state.http.end();
          this.input.observe({ id: envelope.id, event: "upload", bytes: bytes.byteLength });
        }
      })
      .catch(async () => {
        if (!state.cancelled && !state.responseStarted && !this.#closed) {
          state.cancelled = true;
          state.responseEnded = true;
          state.http.close();
          await this.#error(envelope.id, "http-upload-failed");
        }
      })
      .finally(async () => {
        // Discarding a chunk after cancellation, failed write or early response also
        // consumes it. Its sender's shared window must drain in every outcome.
        if (!this.#closed && !this.input.channel.signal.aborted)
          await this.input.channel.send({ t: "ack", id: envelope.id, seq: envelope.seq });
        this.#release(envelope.id, state);
      });
    state.writes = writing;
    this.#track(writing);
    return writing;
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const state of this.#requests.values()) {
        state.cancelled = true;
        state.http.close();
      }
      this.#requests.clear();
    }
    await Promise.allSettled(this.#tasks);
  }

  #open(envelope: HttpRequest): Promise<void> {
    if (this.#requests.has(envelope.id)) return this.#error(envelope.id, "duplicate-http-request");
    let http: LoopbackHttpTransfer;
    try {
      http = openLoopbackHttp({
        origin: this.input.origin,
        credential: this.input.credential,
        method: envelope.method,
        path: envelope.path,
        ...(envelope.contentType === undefined ? {} : { contentType: envelope.contentType }),
        signal: this.input.channel.signal,
      });
    } catch (error) {
      return this.#error(
        envelope.id,
        error instanceof TunnelPathError ? error.code : "http-open-failed",
      );
    }
    const state: Transfer = {
      http,
      next: 0,
      uploadEnded: envelope.method === "GET",
      responseStarted: false,
      responseEnded: false,
      cancelled: false,
      writes: Promise.resolve(),
    };
    this.#requests.set(envelope.id, state);
    this.input.observe({ id: envelope.id, event: "opened" });
    const responding = (async () => {
      try {
        const response = await http.response;
        state.responseStarted = true;
        await this.input.channel.send(
          { t: "http.res", id: envelope.id, status: response.status, headers: response.headers },
          http.signal,
        );
        for await (const packet of encodeHttpBody({ id: envelope.id, body: response.body })) {
          await this.input.channel.send(packet.envelope, http.signal);
          this.input.observe({
            id: envelope.id,
            event: "download",
            bytes: Buffer.byteLength(packet.envelope.body, "base64"),
          });
        }
        state.responseEnded = true;
        this.input.observe({ id: envelope.id, event: "response-sent" });
      } catch (error) {
        if (!state.cancelled && !this.#closed && !this.input.channel.signal.aborted) {
          state.cancelled = true;
          state.responseEnded = true;
          await this.#error(
            envelope.id,
            error instanceof LoopbackHttpError ? error.code : "http-response-failed",
          );
        }
      } finally {
        http.close();
        this.#release(envelope.id, state);
      }
    })();
    this.#track(responding);
    // Opening starts a background response pump, not a wait for the whole body.
    return Promise.resolve();
  }

  #release(id: number, state: Transfer) {
    if (state.uploadEnded && state.responseEnded && this.#requests.get(id) === state)
      this.#requests.delete(id);
  }
  async #error(id: number, reason: string) {
    this.input.observe({ id, event: "failed" });
    if (!this.#closed && !this.input.channel.signal.aborted)
      await this.input.channel.send({ t: "error", id, reason });
  }
  #track(task: Promise<void>) {
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task)).catch(() => undefined);
  }
}

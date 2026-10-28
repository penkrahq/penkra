import { MAX_WEBSOCKET_MESSAGE_BYTES } from "../nodeHttpServer";
import { openLoopbackWs } from "./loopbackWs";
import type { TunnelChannel } from "./tunnelChannel";
import type { TunnelEnvelope } from "./tunnelCodec";
import { TunnelPathError } from "./tunnelPaths";
import { wsTextChunks } from "./wsTextChunks";
import { WsTextReceiver, RpcReplyTooLarge } from "./wsTextReceiver";

type WsInput = Extract<TunnelEnvelope, { t: "ws.open" | "ws.msg" | "ws.close" }>;
interface Connection {
  socket: ReturnType<typeof openLoopbackWs>;
  receive: WsTextReceiver;
  writes: Promise<void>;
  stopped: AbortController;
  next: number;
}

/** Per-socket reassembly and writes; never await one socket before dispatching
 * unrelated socket messages or encrypted channel ACKs in the relay reader.
 */
export class RemoteWsBridge {
  readonly #connections = new Map<number, Connection>();
  readonly #tasks = new Set<Promise<void>>();
  #closed = false;
  constructor(
    private readonly input: {
      origin: string;
      credential: string;
      channel: Pick<TunnelChannel, "send" | "signal">;
      observe: (event: {
        id: number;
        event: "opened" | "received" | "sent" | "closed" | "failed";
        bytes?: number;
      }) => void;
    },
  ) {}

  accept(envelope: WsInput): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("RemoteLink WS bridge is closed."));
    if (envelope.t === "ws.open") return this.#open(envelope.id, envelope.path);
    const state = this.#connections.get(envelope.id);
    if (envelope.t === "ws.close") {
      if (state) this.#stop(envelope.id, state, true);
      return Promise.resolve();
    }
    if (!state)
      return this.input.channel
        .send({ t: "ack", id: envelope.id, seq: envelope.seq })
        .then(() => this.#error(envelope.id, "unknown-ws-stream"));
    if (state.stopped.signal.aborted)
      return this.input.channel.send({ t: "ack", id: envelope.id, seq: envelope.seq });
    let message: string | undefined;
    try {
      message = state.receive.accept(envelope);
    } catch (error) {
      this.#stop(envelope.id, state);
      return this.input.channel.send({ t: "ack", id: envelope.id, seq: envelope.seq }).then(() =>
        this.input.channel.send({
          t: "ws.close",
          id: envelope.id,
          code: error instanceof RpcReplyTooLarge ? 1009 : 1002,
        }),
      );
    }
    // Copying into the bounded per-stream assembly consumes a nonfinal chunk.
    // A final message waits for its loopback write before granting its credit.
    const writing = state.writes
      .then(async () => {
        if (message !== undefined && !state.stopped.signal.aborted)
          await state.socket.write(message);
      })
      .catch(async () => {
        this.#stop(envelope.id, state);
        await this.#error(envelope.id, "ws-write-failed");
      })
      .finally(async () => {
        if (!this.#closed && !this.input.channel.signal.aborted) {
          await this.input.channel.send({ t: "ack", id: envelope.id, seq: envelope.seq });
          this.input.observe({
            id: envelope.id,
            event: "received",
            bytes: Buffer.byteLength(envelope.data),
          });
        }
      });
    state.writes = writing;
    this.#track(writing);
    return writing;
  }

  async close() {
    this.#closed = true;
    for (const [id, state] of this.#connections) this.#stop(id, state, true);
    await Promise.allSettled(this.#tasks);
  }

  #open(id: number, path: string): Promise<void> {
    if (this.#connections.has(id)) return this.#error(id, "duplicate-ws-stream");
    const stopped = new AbortController();
    const signal = AbortSignal.any([this.input.channel.signal, stopped.signal]);
    let socket: ReturnType<typeof openLoopbackWs>;
    try {
      socket = openLoopbackWs({
        origin: this.input.origin,
        credential: this.input.credential,
        path,
        signal,
      });
    } catch (error) {
      return this.#error(id, error instanceof TunnelPathError ? error.code : "ws-open-failed");
    }
    const state: Connection = {
      socket,
      receive: new WsTextReceiver(MAX_WEBSOCKET_MESSAGE_BYTES),
      writes: Promise.resolve(),
      stopped,
      next: 0,
    };
    this.#connections.set(id, state);
    this.input.observe({ id, event: "opened" });
    const pump = (async () => {
      try {
        for await (const text of socket.messages()) {
          for (const chunk of wsTextChunks({ id, seq: state.next, text })) {
            await this.input.channel.send(chunk, signal);
            state.next = chunk.seq + 1;
            this.input.observe({ id, event: "sent", bytes: Buffer.byteLength(chunk.data) });
          }
        }
        if (!signal.aborted && !this.#closed)
          await this.input.channel.send({ t: "ws.close", id, code: 1000 });
      } catch {
        if (!signal.aborted && !this.#closed) await this.#error(id, "ws-stream-failed");
      } finally {
        this.#stop(id, state);
      }
    })();
    this.#track(pump);
    return Promise.resolve();
  }

  #stop(id: number, state: Connection, forget = false) {
    const wasStopped = state.stopped.signal.aborted;
    state.stopped.abort();
    state.receive.close();
    state.socket.close();
    if (forget && this.#connections.get(id) === state) this.#connections.delete(id);
    if (!wasStopped) this.input.observe({ id, event: "closed" });
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

import { RemoteHttpBridge } from "./httpBridge";
import { RemoteWsBridge } from "./wsBridge";
import { TunnelChannel } from "./tunnelChannel";
import type { NoiseTransport } from "./noise";

export interface RemoteSessionEvent {
  readonly phoneDeviceId: string;
  readonly sessionId: string;
  readonly transport: "http" | "ws" | "noise";
  readonly event: string;
  readonly id?: number;
  readonly bytes?: number;
}

/** One authenticated phone session owns all of its sockets, transfers and
 * push-suppression state. The relay reader invokes receive synchronously in
 * packet order; request consumption must never block receiving control ACKs.
 */
export class RemoteSessionBridge {
  readonly channel: TunnelChannel;
  readonly #http: RemoteHttpBridge;
  readonly #ws: RemoteWsBridge;
  #viewing: string | null = null;
  #closing: Promise<void> | undefined;

  constructor(
    private readonly input: {
      phoneDeviceId: string;
      sessionId: string;
      origin: string;
      credential: string;
      transport: Pick<NoiseTransport, "send" | "receive">;
      sendWire: (ciphertext: Uint8Array) => Promise<void>;
      observe: (event: RemoteSessionEvent) => void;
      onViewing: (threadId: string | null) => void;
    },
  ) {
    this.channel = new TunnelChannel(input.transport, input.sendWire);
    this.#http = new RemoteHttpBridge({
      origin: input.origin,
      credential: input.credential,
      channel: this.channel,
      observe: (event) => this.#observe("http", event),
    });
    this.#ws = new RemoteWsBridge({
      origin: input.origin,
      credential: input.credential,
      channel: this.channel,
      observe: (event) => this.#observe("ws", event),
    });
    this.channel.signal.addEventListener(
      "abort",
      () => {
        void this.close();
      },
      { once: true },
    );
  }

  get viewingThreadId() {
    return this.#viewing;
  }

  receive(ciphertext: Uint8Array): void {
    let work: Promise<void> | undefined;
    try {
      const message = this.channel.receive(ciphertext);
      if (!message) return;
      switch (message.t) {
        case "http":
        case "http.body":
        case "http.cancel":
          work = this.#http.accept(message);
          break;
        case "ws.open":
        case "ws.msg":
        case "ws.close":
          work = this.#ws.accept(message);
          break;
        case "viewing":
          this.#viewing = message.threadId;
          this.input.onViewing(message.threadId);
          break;
        default:
          // A phone cannot inject server replies/errors into its Mac client.
          throw new Error("Unexpected RemoteLink envelope direction.");
      }
    } catch {
      this.#observe("noise", { event: "protocol-failed" });
      void this.close();
      return;
    }
    void work?.catch(() => {
      this.#observe("noise", { event: "request-dispatch-failed" });
      void this.close();
    });
  }

  close(): Promise<void> {
    if (!this.#closing) {
      // Assign before abort fires the reentrant close listener.
      this.#closing = Promise.resolve().then(async () => {
        await Promise.all([this.#http.close(), this.#ws.close()]);
        this.#observe("noise", { event: "closed" });
      });
      this.channel.close();
      this.#viewing = null;
      this.input.onViewing(null);
    }
    return this.#closing;
  }

  #observe(
    transport: RemoteSessionEvent["transport"],
    event: { event: string; id?: number; bytes?: number },
  ) {
    this.input.observe({
      phoneDeviceId: this.input.phoneDeviceId,
      sessionId: this.input.sessionId,
      transport,
      ...event,
    });
  }
}

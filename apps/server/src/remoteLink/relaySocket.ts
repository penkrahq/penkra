import WebSocket, { createWebSocketStream } from "ws";
import { isLoopbackHost } from "../startupAccess";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  RELAY_MAX_FRAME_BYTES,
  RELAY_VERSION,
  type RelayFrame,
} from "./relayProtocol";

export class RemoteRelayError extends Error {
  constructor(
    readonly code: "invalid-url" | "connection-failed" | "closed" | "write-failed",
    readonly status?: number,
  ) {
    super(`RemoteLink relay ${code}.`);
  }
}
type CloseReason =
  | "remote-close"
  | "aborted"
  | "protocol-failed"
  | "connection-failed"
  | "write-failed";
export interface RelaySocketEvent {
  readonly event: "opened" | "received" | "sent" | "closed";
  readonly bytes?: number;
  readonly reason?: CloseReason;
  readonly code?: number;
}
interface Input {
  readonly url: string;
  readonly deviceToken: string;
  readonly signal: AbortSignal;
  /** Dispatch only; per-session work owns its own asynchronous lifetime. */
  readonly onFrame: (frame: RelayFrame) => undefined;
  readonly observe: (event: RelaySocketEvent) => void;
}

function relayUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHost(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/v1" ||
    url.search ||
    url.hash
  ) {
    throw new RemoteRelayError("invalid-url");
  }
  return url;
}

/** One real relay socket. Its owner decides when to reconnect; this layer has no
 * retry loop, timer, application input queue or message-content logging.
 */
export class RemoteRelaySocket {
  readonly finished: Promise<{ readonly code: number; readonly reason: CloseReason }>;
  readonly #socket: WebSocket;
  readonly #stream: ReturnType<typeof createWebSocketStream>;
  readonly #opening = Promise.withResolvers<void>();
  #stopped = false;
  #reason: CloseReason = "remote-close";

  private constructor(
    private readonly input: Input,
    url: URL,
  ) {
    this.#socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${input.deviceToken}`,
        "Penkra-Relay-Version": String(RELAY_VERSION),
      },
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: RELAY_MAX_FRAME_BYTES,
    });
    const stream = createWebSocketStream(this.#socket, {
      readableObjectMode: true,
      readableHighWaterMark: 1,
      decodeStrings: false,
    });
    this.#stream = stream;
    this.#stream.on("error", () => undefined);
    const closed = Promise.withResolvers<number>();
    this.#socket.once("open", () => {
      this.#opening.resolve();
      this.#observe({ event: "opened" });
    });
    this.#socket.on("error", () => {
      this.#opening.reject(new RemoteRelayError("connection-failed"));
      this.#stop("connection-failed");
    });
    this.#socket.once("unexpected-response", (_request, response) => {
      response.resume();
      this.#opening.reject(new RemoteRelayError("connection-failed", response.statusCode));
      this.#stop("connection-failed");
    });
    this.#socket.once("close", (code) => {
      this.#stop("remote-close");
      input.signal.removeEventListener("abort", abort);
      this.#opening.reject(new RemoteRelayError("closed"));
      closed.resolve(code);
    });
    const abort = () => {
      this.#opening.reject(new RemoteRelayError("closed"));
      this.#stop("aborted");
    };
    input.signal.addEventListener("abort", abort, { once: true });
    const reading = (async () => {
      try {
        for await (const bytes of stream) {
          if (!Buffer.isBuffer(bytes)) throw new Error("Relay frames must be binary.");
          const frame = decodeRelayFrame(bytes);
          this.#observe({ event: "received", bytes: bytes.byteLength });
          input.onFrame(frame);
        }
      } catch {
        this.#stop("protocol-failed");
      } finally {
        this.close();
      }
    })();
    this.finished = Promise.all([closed.promise, reading]).then(([code]) => {
      const result = { code, reason: this.#reason };
      this.#observe({ event: "closed", ...result });
      return result;
    });
    if (input.signal.aborted) abort();
  }

  static async open(input: Input): Promise<RemoteRelaySocket> {
    if (input.signal.aborted) throw new RemoteRelayError("closed");
    let url: URL;
    try {
      url = relayUrl(input.url);
    } catch {
      throw new RemoteRelayError("invalid-url");
    }
    let connection: RemoteRelaySocket;
    try {
      connection = new RemoteRelaySocket(input, url);
    } catch {
      throw new RemoteRelayError("connection-failed");
    }
    try {
      await connection.#opening.promise;
      return connection;
    } catch (error) {
      connection.close();
      await connection.finished;
      throw error;
    }
  }

  async send(frame: RelayFrame): Promise<void> {
    if (this.#stopped || this.#socket.readyState !== WebSocket.OPEN)
      throw new RemoteRelayError("closed");
    const bytes = encodeRelayFrame(frame);
    try {
      await new Promise<void>((resolve, reject) =>
        this.#stream.write(bytes, (error) => (error ? reject(error) : resolve())),
      );
      this.#observe({ event: "sent", bytes: bytes.byteLength });
    } catch {
      this.#stop("write-failed");
      throw new RemoteRelayError("write-failed");
    }
  }
  close() {
    this.#stop("aborted");
  }
  #stop(reason: CloseReason) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reason = reason;
    this.#stream.destroy();
    this.#socket.terminate();
  }
  #observe(event: RelaySocketEvent) {
    try {
      this.input.observe(event);
    } catch {
      /* Diagnostics cannot own the socket. */
    }
  }
}

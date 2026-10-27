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
    readonly code:
      | "invalid-url"
      | "connection-failed"
      | "protocol-failed"
      | "closed"
      | "write-failed",
    readonly status?: number,
  ) {
    super(`RemoteLink relay ${code}.`);
  }
}
// Public ws receiver error codes: https://github.com/websockets/ws/blob/master/doc/ws.md#error-codes
// Match the structured code, never error prose or a guessed string prefix.
const PROTOCOL_ERROR_CODES = new Set([
  "WS_ERR_EXPECTED_FIN",
  "WS_ERR_EXPECTED_MASK",
  "WS_ERR_INVALID_CLOSE_CODE",
  "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH",
  "WS_ERR_INVALID_OPCODE",
  "WS_ERR_INVALID_UTF8",
  "WS_ERR_UNEXPECTED_MASK",
  "WS_ERR_UNEXPECTED_RSV_1",
  "WS_ERR_UNEXPECTED_RSV_2_3",
  "WS_ERR_TOO_MANY_BUFFERED_PARTS",
  "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH",
  "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
]);
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
export interface RelaySocketInput {
  readonly url: string;
  readonly deviceToken: string;
  readonly signal: AbortSignal;
  /** Dispatch only; per-session work owns its own asynchronous lifetime. */
  readonly onFrame: (frame: RelayFrame) => undefined;
  /** Install the connection's receiver before the relay can deliver frames. */
  readonly onConnected?: (socket: RemoteRelaySocket) => void;
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
    private readonly input: RelaySocketInput,
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
      try {
        input.onConnected?.(this);
      } catch (error) {
        this.#opening.reject(error);
        this.#stop("connection-failed");
        return;
      }
      this.#opening.resolve();
      this.#observe({ event: "opened" });
    });
    this.#socket.on("error", (error) => {
      const reason =
        "code" in error && typeof error.code === "string" && PROTOCOL_ERROR_CODES.has(error.code)
          ? "protocol-failed"
          : "connection-failed";
      this.#opening.reject(new RemoteRelayError(reason));
      this.#stop(reason);
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

  static async open(input: RelaySocketInput): Promise<RemoteRelaySocket> {
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

  /** Flush a final frame before the WebSocket close handshake. A completed
   * write is not an application-level acknowledgement from the relay. */
  async finish(frame: RelayFrame): Promise<void> {
    await this.send(frame);
    if (!this.#stopped) this.#socket.close();
    await this.finished;
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

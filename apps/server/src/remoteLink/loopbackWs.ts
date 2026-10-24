import WebSocket, { createWebSocketStream } from "ws";
import { loopbackOrigin } from "./loopbackOrigin";
import { resolveTunnelPath } from "./tunnelPaths";

/** One loopback socket, owned by the phone's Noise scope. The stream's object
 * mode preserves complete text messages; pulls backpressure the ws receiver.
 */
export function openLoopbackWs(input: {
  origin: string;
  credential: string;
  path: string;
  signal: AbortSignal;
}) {
  if (input.signal.aborted) throw new Error("RemoteLink socket cancelled.");
  const origin = loopbackOrigin(input.origin);
  const path = resolveTunnelPath({ kind: "ws", method: "GET", path: input.path });
  const url = new URL(path, origin);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${input.credential}` },
    perMessageDeflate: false,
    followRedirects: false,
  });
  const stream = createWebSocketStream(socket, {
    readableObjectMode: true,
    readableHighWaterMark: 1,
    decodeStrings: false,
  });
  let closed = false;
  // A connecting socket can fail before its owner starts the response pump.
  stream.on("error", () => undefined);
  const close = () => {
    if (closed) return;
    closed = true;
    input.signal.removeEventListener("abort", close);
    stream.destroy();
    socket.terminate();
  };
  socket.once("close", () => {
    input.signal.removeEventListener("abort", close);
  });
  input.signal.addEventListener("abort", close, { once: true });
  if (input.signal.aborted) close();
  return {
    async *messages(): AsyncGenerator<string> {
      try {
        for await (const message of stream) {
          if (typeof message !== "string") throw new Error("RemoteLink expects RPC text messages.");
          yield message;
        }
      } catch {
        throw new Error("RemoteLink loopback WebSocket failed.");
      } finally {
        close();
      }
    },
    write: (text: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("RemoteLink socket is closed."));
          return;
        }
        stream.write(text, (error) =>
          error ? reject(new Error("RemoteLink loopback write failed.")) : resolve(),
        );
      }),
    close,
  };
}

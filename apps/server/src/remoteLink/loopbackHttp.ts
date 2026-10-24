import { request as httpRequest, type IncomingMessage } from "node:http";
import { loopbackOrigin } from "./loopbackOrigin";
import { resolveTunnelPath } from "./tunnelPaths";

export class LoopbackHttpError extends Error {
  constructor(
    readonly code:
      | "invalid-origin"
      | "invalid-state"
      | "cancelled"
      | "closed"
      | "request-failed"
      | "response-failed",
  ) {
    super(`RemoteLink HTTP transfer: ${code}.`);
    this.name = "LoopbackHttpError";
  }
}
export interface LoopbackHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}
export interface LoopbackHttpTransfer {
  readonly signal: AbortSignal;
  readonly response: Promise<LoopbackHttpResponse>;
  /** The receiver acknowledges an upload chunk only after this resolves. Never call concurrently. */
  write(bytes: Uint8Array): Promise<void>;
  end(): void;
  close(): void;
}

/** Owned by one Noise session. The caller MUST close the transfer when that scope ends.
 * Request chunks are written serially; response chunks are pulled by the encrypted sender.
 * Neither direction concatenates bodies. No redirects, shared sockets, or idle timeout.
 */
export function openLoopbackHttp(input: {
  readonly origin: string;
  readonly credential: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly contentType?: string;
  readonly signal?: AbortSignal;
}): LoopbackHttpTransfer {
  let origin: URL;
  try {
    origin = loopbackOrigin(input.origin);
  } catch {
    throw new LoopbackHttpError("invalid-origin");
  }
  if (input.signal?.aborted) throw new LoopbackHttpError("cancelled");
  const path = resolveTunnelPath({ kind: "http", method: input.method, path: input.path });
  const headers = {
    authorization: `Bearer ${input.credential}`,
    ...(input.contentType === undefined ? {} : { "content-type": input.contentType }),
  };
  let request: ReturnType<typeof httpRequest>;
  try {
    request = httpRequest(new URL(path, origin), { method: input.method, headers, agent: false });
  } catch {
    throw new LoopbackHttpError("request-failed");
  }

  let incoming: IncomingMessage | undefined;
  let terminal: LoopbackHttpError | undefined;
  let closed = false;
  let responseComplete = false;
  const stopped = new AbortController();
  let ended = input.method === "GET";
  let rejectWrite: ((error: LoopbackHttpError) => void) | undefined;
  let resolveResponse!: (value: LoopbackHttpResponse) => void;
  let rejectResponse!: (error: LoopbackHttpError) => void;
  const response = new Promise<LoopbackHttpResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  // A server can reject before an upload's write finishes. Preserve the rejection for
  // the caller without an unhandled rejection while it is still awaiting that write.
  void response.catch(() => undefined);
  const finish = (error: LoopbackHttpError) => {
    if (closed) return;
    closed = true;
    terminal = error;
    stopped.abort(error);
    input.signal?.removeEventListener("abort", abort);
    const pending = rejectWrite;
    rejectWrite = undefined;
    pending?.(error);
    rejectResponse(error);
    incoming?.destroy();
    request.destroy();
  };
  const abort = () => finish(new LoopbackHttpError("cancelled"));
  request.on("error", () => {
    if (!responseComplete) finish(new LoopbackHttpError("request-failed"));
  });
  request.once("response", (message) => {
    if (closed) {
      message.destroy();
      return;
    }
    incoming = message;
    message.on("error", () => finish(new LoopbackHttpError("response-failed")));
    const responseHeaders: Record<string, string> = {};
    // Only representation metadata, never cookies, credentials, or connection headers.
    for (const name of [
      "content-type",
      "content-length",
      "content-disposition",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ] as const) {
      const value = message.headers[name];
      if (typeof value === "string") responseHeaders[name] = value;
    }
    async function* body(): AsyncGenerator<Uint8Array> {
      let consumed = false;
      try {
        if (terminal) throw terminal;
        for await (const chunk of message) {
          if (terminal) throw terminal;
          yield chunk as Buffer;
        }
        if (!message.complete) throw new LoopbackHttpError("response-failed");
        consumed = true;
      } catch {
        throw terminal ?? new LoopbackHttpError("response-failed");
      } finally {
        if (!consumed) finish(terminal ?? new LoopbackHttpError("cancelled"));
        else {
          // HTTP EOF is not tunnel EOF: the sender still has to send/ack its final
          // encrypted chunk. Keep its cancellation signal alive until scope close.
          responseComplete = true;
          ended = true;
          const pending = rejectWrite;
          rejectWrite = undefined;
          pending?.(new LoopbackHttpError("closed"));
          message.destroy();
          request.destroy();
        }
      }
    }
    resolveResponse({ status: message.statusCode!, headers: responseHeaders, body: body() });
  });
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  else if (ended) request.end();
  else request.flushHeaders();

  return {
    signal: stopped.signal,
    response,
    write: (bytes) => {
      if (terminal) return Promise.reject(terminal);
      if (closed || ended || rejectWrite)
        return Promise.reject(new LoopbackHttpError("invalid-state"));
      return new Promise<void>((resolve, reject) => {
        rejectWrite = reject;
        try {
          request.write(bytes, (error) => {
            rejectWrite = undefined;
            if (terminal) reject(terminal);
            else if (error) {
              const failure = new LoopbackHttpError("request-failed");
              finish(failure);
              reject(failure);
            } else resolve();
          });
        } catch {
          const failure = new LoopbackHttpError("request-failed");
          finish(failure);
          reject(failure);
        }
      });
    },
    end: () => {
      if (terminal) throw terminal;
      if (ended || rejectWrite) throw new LoopbackHttpError("invalid-state");
      ended = true;
      request.end();
    },
    close: abort,
  };
}

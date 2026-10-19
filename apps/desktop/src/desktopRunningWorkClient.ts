import { DesktopRunningWorkState } from "@penkra/contracts";
import { Schema } from "effect";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** Node's response stream has no idle deadline. Abort belongs to the backend generation. */
const openRunningWorkStream: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        signal: init?.signal ?? undefined,
        headers,
      },
      (response) => {
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode ?? 500,
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
};

/** One backend generation owns its stream, including an event-driven reopen. */
export class DesktopRunningWorkClient {
  #current: AbortController | null = null;
  readonly #onWorking: (working: ReadonlyArray<string>) => void;
  readonly #onError: (error: unknown) => void;
  readonly #fetch: typeof fetch;
  constructor(input: {
    onWorking: (working: ReadonlyArray<string>) => void;
    onError: (error: unknown) => void;
    fetcher?: typeof fetch;
  }) {
    this.#onWorking = input.onWorking;
    this.#onError = input.onError;
    this.#fetch = input.fetcher ?? openRunningWorkStream;
  }
  async start(backend: { url: string; token: string }): Promise<void> {
    this.stop();
    const controller = new AbortController();
    this.#current = controller;
    let receivedState = false;
    try {
      while (!controller.signal.aborted) {
        try {
          const response = await this.#fetch(`${backend.url}/api/desktop/running-work`, {
            headers: { Authorization: `Bearer ${backend.token}` },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`Running-work stream failed (${response.status}).`);
          }
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let pending = "";
          try {
            while (!controller.signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              pending += chunk.value;
              let end: number;
              while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                const state = Schema.decodeUnknownSync(DesktopRunningWorkState)(JSON.parse(line));
                receivedState = true;
                if (this.#current === controller && !controller.signal.aborted)
                  this.#onWorking(state.working);
              }
            }
            if (pending.length > 0 && !controller.signal.aborted)
              throw new Error("Running-work stream ended with an incomplete state.");
          } finally {
            await reader.cancel();
          }
        } catch (error) {
          if (!controller.signal.aborted) this.#onError(error);
        }
        if (controller.signal.aborted || !receivedState) break;
        receivedState = false;
        console.info("[desktop-power] Reopening running-work stream.");
      }
    } finally {
      if (this.#current === controller) {
        this.#current = null;
        this.#onWorking([]);
      }
    }
  }
  stop(): void {
    const previous = this.#current;
    this.#current = null;
    previous?.abort();
    this.#onWorking([]);
  }
}

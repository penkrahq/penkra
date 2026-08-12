// FILE: simulatorMjpegStream.ts
// Purpose: Consumes WebDriverAgent's standard loopback MJPEG stream as bounded JPEG frames.
// Layer: Trusted desktop simulator transport

import type { SimulatorFrame, SimulatorFrameSubscription } from "./simulatorManager";

const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export class MjpegFrameParser {
  readonly #onFrame: (frame: Uint8Array) => void;
  #buffer = new Uint8Array(0);

  constructor(onFrame: (frame: Uint8Array) => void) {
    this.#onFrame = onFrame;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    combined.set(this.#buffer);
    combined.set(chunk, this.#buffer.byteLength);
    this.#buffer = combined;

    while (true) {
      const start = findMarker(this.#buffer, 0, 0xff, 0xd8);
      if (start < 0) {
        this.#buffer = this.#buffer.at(-1) === 0xff ? this.#buffer.slice(-1) : new Uint8Array(0);
        return;
      }
      const end = findMarker(this.#buffer, start + 2, 0xff, 0xd9);
      if (end < 0) {
        this.#buffer = this.#buffer.slice(start);
        if (this.#buffer.byteLength > MAX_BUFFER_BYTES) {
          this.#buffer = new Uint8Array(0);
          throw streamError("FRAME_TOO_LARGE", "Apple simulator frame exceeded the size limit.");
        }
        return;
      }
      this.#onFrame(this.#buffer.slice(start, end + 2));
      this.#buffer = this.#buffer.slice(end + 2);
    }
  }
}

export function subscribeMjpegFrames(input: {
  url: string;
  onFrame(frame: SimulatorFrame): void;
  onError(error: Error): void;
  fetch?: typeof fetch;
}): SimulatorFrameSubscription {
  const controller = new AbortController();
  let stopped = false;
  const parser = new MjpegFrameParser((data) => input.onFrame({ mimeType: "image/jpeg", data }));
  void consume(input.fetch ?? fetch, input.url, controller.signal, parser).catch((error) => {
    if (!stopped && !controller.signal.aborted) input.onError(asError(error));
  });
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
  };
}

async function consume(
  request: typeof fetch,
  url: string,
  signal: AbortSignal,
  parser: MjpegFrameParser,
): Promise<void> {
  const response = await request(url, { signal });
  if (!response.ok || !response.body) {
    throw streamError(
      "FRAME_STREAM_UNAVAILABLE",
      `Apple frame stream returned HTTP ${response.status}.`,
    );
  }
  const reader = response.body.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    parser.push(result.value);
  }
  if (!signal.aborted) throw streamError("FRAME_STREAM_ENDED", "Apple frame stream ended.");
}

function findMarker(buffer: Uint8Array, from: number, first: number, second: number): number {
  for (let index = from; index + 1 < buffer.byteLength; index += 1) {
    if (buffer[index] === first && buffer[index + 1] === second) return index;
  }
  return -1;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function streamError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

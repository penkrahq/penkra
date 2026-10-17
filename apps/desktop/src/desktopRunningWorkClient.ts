import { DesktopRunningWorkState } from "@penkra/contracts";
import { Schema } from "effect";

/** One backend generation owns its stream. Reconnection is driven only by backend readiness. */
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
    this.#fetch = input.fetcher ?? fetch;
  }
  async start(backend: { url: string; token: string }): Promise<void> {
    this.stop();
    const controller = new AbortController();
    this.#current = controller;
    try {
      const response = await this.#fetch(`${backend.url}/api/desktop/running-work`, {
        headers: { Authorization: `Bearer ${backend.token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`Running-work stream failed (${response.status}).`);
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

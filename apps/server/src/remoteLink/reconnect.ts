// TODO 7.5.10: spread reconnects after a relay restart; never an idle watchdog.
export const RELAY_RECONNECT_BASE_MS = 5000;
export const RELAY_RECONNECT_MAX_MS = 30000;

export type RelayAttemptEnd =
  | { readonly reason: "transport-failed" }
  | { readonly reason: "authentication-rejected" | "protocol-rejected" };
export type RelayReconnectEvent = "wake" | "network-path" | "sign-in" | "access-enabled";
export type RelayReconnectState =
  | { readonly state: "connecting" }
  | { readonly state: "waiting"; readonly delayMs: number }
  | { readonly state: "rejected"; readonly reason: "authentication-rejected" | "protocol-rejected" }
  | { readonly state: "stopped" };

/** Owns one connection lifetime at a time. The attempt must release its socket
 * and sessions before resolving, including when its signal is aborted.
 * Only confirmed transport failures schedule another attempt. Local lifecycle
 * events cancel either the current attempt or its delay and start afresh.
 */
export class RelayReconnectLoop {
  readonly finished: Promise<void>;
  #closed = false;
  #revision = 0;
  #current: AbortController | undefined;
  #event = Promise.withResolvers<void>();

  constructor(
    private readonly input: {
      readonly attempt: (signal: AbortSignal) => Promise<RelayAttemptEnd>;
      readonly observe: (state: RelayReconnectState) => void;
    },
  ) {
    this.finished = this.#run();
  }

  reconnect(_event: RelayReconnectEvent): void {
    if (this.#closed) return;
    this.#revision++;
    this.#current?.abort();
    this.#event.resolve();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#current?.abort();
    this.#event.resolve();
    await this.finished;
  }

  #observe(state: RelayReconnectState): void {
    try {
      this.input.observe(state);
    } catch {
      // Diagnostics do not own the connection lifetime.
    }
  }

  async #run(): Promise<void> {
    let ceilingMs = RELAY_RECONNECT_BASE_MS;
    try {
      while (!this.#closed) {
        const revision = this.#revision;
        this.#event = Promise.withResolvers<void>();
        const current = new AbortController();
        this.#current = current;
        this.#observe({ state: "connecting" });
        const end = await this.input.attempt(current.signal);
        if (this.#closed) break;
        if (revision !== this.#revision) {
          ceilingMs = RELAY_RECONNECT_BASE_MS;
          continue;
        }
        if (end.reason !== "transport-failed") {
          this.#observe({ state: "rejected", reason: end.reason });
          await this.#event.promise;
          ceilingMs = RELAY_RECONNECT_BASE_MS;
          continue;
        }
        const delayMs = Math.random() * ceilingMs;
        ceilingMs = Math.min(ceilingMs * 2, RELAY_RECONNECT_MAX_MS);
        this.#observe({ state: "waiting", delayMs });
        await waitForReconnect(delayMs, current.signal);
        if (revision !== this.#revision) ceilingMs = RELAY_RECONNECT_BASE_MS;
      }
    } finally {
      this.#closed = true;
      this.#current = undefined;
      this.#observe({ state: "stopped" });
    }
  }
}

function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

import type { RemoteLifecycleEvent, RemoteLifecycleSnapshot } from "@penkra/contracts";
import type { RelayReconnectEvent } from "./reconnect";

export interface RemoteAccountWork {
  reconnect(event: RelayReconnectEvent): void;
  close(reason: RemoteLifecycleEvent["event"] | "disconnect"): Promise<void>;
}

/** Mounted registration, relay, and phone-session work has exactly one owner.
 * mount starts owned work synchronously; readiness belongs to that work, not to
 * the desktop transition ACK. close must abort and join all of it.
 */
export class RemoteAccountLifetime {
  #current:
    | {
        snapshot: RemoteLifecycleSnapshot;
        controller: AbortController;
        work: RemoteAccountWork;
        closing?: Promise<void>;
      }
    | undefined;
  #applying: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly mount: (
      snapshot: RemoteLifecycleSnapshot & { accountId: string },
      signal: AbortSignal,
    ) => RemoteAccountWork,
  ) {}

  apply(event: RemoteLifecycleEvent, signal: AbortSignal): Promise<void> {
    if (this.#applying)
      return Promise.reject(new Error("Concurrent RemoteLink lifecycle transition."));
    const applying = this.#apply(event, signal);
    this.#applying = applying;
    return applying.finally(() => {
      if (this.#applying === applying) this.#applying = undefined;
    });
  }

  async #apply(event: RemoteLifecycleEvent, signal: AbortSignal): Promise<void> {
    if (this.#closed || signal.aborted) return;
    const next = event.snapshot;
    const active = next.accountId !== null && next.accessOn && !next.suspended;
    const current = this.#current;
    const same =
      current &&
      current.snapshot.accountServiceUrl === next.accountServiceUrl &&
      current.snapshot.accountId === next.accountId;
    if (
      active &&
      same &&
      !current.closing &&
      (event.event === "wake" || event.event === "network-path")
    ) {
      current.work.reconnect(event.event);
      return;
    }
    await this.#stop(event.event);
    if (!active || next.accountId === null || this.#closed || signal.aborted) return;
    const controller = new AbortController();
    try {
      const work = this.mount({ ...next, accountId: next.accountId }, controller.signal);
      this.#current = { snapshot: { ...next }, controller, work };
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  #stop(reason: RemoteLifecycleEvent["event"] | "disconnect"): Promise<void> {
    const current = this.#current;
    if (!current) return Promise.resolve();
    // The suspend close owns sending SLEEP before releasing its socket. Other
    // transitions cancel preparation immediately; none wait for new readiness.
    if (reason !== "suspend") current.controller.abort();
    current.closing ??= Promise.resolve()
      .then(() => current.work.close(reason))
      .finally(() => current.controller.abort())
      .then(() => {
        if (this.#current === current) this.#current = undefined;
      });
    return current.closing;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#current?.controller.abort();
    try {
      await this.#applying;
    } finally {
      await this.#stop("disconnect");
    }
  }
}

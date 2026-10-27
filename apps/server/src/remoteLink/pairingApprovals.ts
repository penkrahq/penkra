import { randomUUID } from "node:crypto";

// Approved no-answer deadline, TODO 7.2.6. Not a connection/agent watchdog.
export const PAIRING_REQUEST_TTL_MS = 120_000;
export type PairingDecision = "allow" | "deny" | "expired";
export interface RemotePairingRequest {
  readonly requestId: string;
  readonly phoneDeviceId: string;
  readonly phoneName: string;
  readonly phoneModel: string;
  readonly code: string;
}
export class PairingCancelled extends Error {
  constructor() {
    super("RemoteLink pairing request cancelled.");
  }
}
interface Pending {
  readonly request: RemotePairingRequest;
  readonly resolve: (decision: PairingDecision) => void;
  readonly reject: (error: PairingCancelled) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

/** One request per phone; the existing single dialog displays arrival order.
 * Request lifetimes belong to their sessions, not to the observing renderer.
 */
export class RemotePairingApprovals {
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  #published: RemotePairingRequest | null = null;
  readonly #listeners = new Set<(request: RemotePairingRequest | null) => void>();
  constructor(private readonly observe: (request: RemotePairingRequest | null) => void) {}

  get current(): RemotePairingRequest | null {
    return this.#published;
  }

  subscribe(listener: (request: RemotePairingRequest | null) => void): () => void {
    if (!this.#closed) this.#listeners.add(listener);
    try {
      listener(this.#published);
    } catch {
      /* Observers do not own consent. */
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  request(
    input: Omit<RemotePairingRequest, "requestId">,
    signal: AbortSignal,
  ): Promise<PairingDecision> {
    if (this.#closed || signal.aborted) return Promise.reject(new PairingCancelled());
    if (!/^\d{6}$/.test(input.code)) return Promise.reject(new Error("Invalid pairing code."));
    const previous = this.#pending.get(input.phoneDeviceId);
    if (previous) this.#finish(previous, undefined, false);
    const result = Promise.withResolvers<PairingDecision>();
    const request = Object.freeze({ ...input, requestId: randomUUID() });
    const pending: Pending = {
      request,
      resolve: result.resolve,
      reject: result.reject,
      signal,
      timer: setTimeout(() => this.#finish(pending, "expired"), PAIRING_REQUEST_TTL_MS),
      abort: () => this.#finish(pending),
    };
    this.#pending.set(input.phoneDeviceId, pending);
    signal.addEventListener("abort", pending.abort, { once: true });
    this.#publish();
    return result.promise;
  }

  answer(requestId: string, allow: boolean): boolean {
    // Only the currently displayed code can be approved. Old answers are inert.
    const first = this.#pending.values().next().value as Pending | undefined;
    if (!first || first.request.requestId !== requestId) return false;
    this.#finish(first, allow ? "allow" : "deny");
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) this.#finish(pending, undefined, false);
    this.#publish();
    this.#listeners.clear();
  }

  #finish(pending: Pending, decision?: PairingDecision, publish = true): void {
    if (this.#pending.get(pending.request.phoneDeviceId) !== pending) return;
    this.#pending.delete(pending.request.phoneDeviceId);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    if (decision === undefined) pending.reject(new PairingCancelled());
    else pending.resolve(decision);
    if (publish) this.#publish();
  }

  #publish(): void {
    const next = this.#pending.values().next().value?.request ?? null;
    if (this.#published === next) return;
    this.#published = next;
    try {
      this.observe(next);
    } catch {
      /* Diagnostics/renderers do not own consent. */
    }
    for (const listener of this.#listeners) {
      if (this.#published !== next) break;
      try {
        listener(next);
      } catch {
        /* Observers do not own consent. */
      }
    }
  }
}

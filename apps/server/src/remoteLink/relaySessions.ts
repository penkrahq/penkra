import { RelayFrameType, type RelayFrame } from "./relayProtocol";

export interface RelaySessionWork {
  receive(bytes: Uint8Array): void;
  /** Settles after all session resources and leases have been released. */
  finished: Promise<void>;
}

/** One relay connection owns its sessions, including retiring sessions. */
export class RelaySessions {
  readonly #current = new Map<string, Entry>();
  readonly #all = new Set<Entry>();
  #closing: Promise<void> | undefined;

  constructor(
    private readonly input: {
      start: (open: RelayFrame, signal: AbortSignal) => RelaySessionWork;
      closePeer: (sessionId: string, peerId: string) => Promise<void>;
      observeFailure: (error: unknown) => void;
    },
  ) {}

  receive(frame: RelayFrame): void {
    if (this.#closing) return;
    const key = `${frame.peerId}:${frame.sessionId}`;
    const previous = this.#current.get(key);
    if (frame.type === RelayFrameType.OPEN) {
      if (previous) {
        previous.peerClosed = true;
        previous.controller.abort();
      }
      const controller = new AbortController();
      let work: RelaySessionWork;
      try {
        work = this.input.start(frame, controller.signal);
      } catch (error) {
        controller.abort();
        this.#current.delete(key);
        this.#report(error);
        void this.input
          .closePeer(frame.sessionId, frame.peerId)
          .catch((cause) => this.#report(cause));
        return;
      }
      const entry: Entry = { controller, work, peerClosed: false };
      this.#current.set(key, entry);
      this.#all.add(entry);
      void work.finished
        .catch((error) => this.#report(error))
        .then(async () => {
          this.#all.delete(entry);
          if (this.#current.get(key) !== entry) return;
          this.#current.delete(key);
          controller.abort();
          if (!this.#closing && !entry.peerClosed)
            await this.input.closePeer(frame.sessionId, frame.peerId);
        })
        .catch((error) => this.#report(error));
      return;
    }
    if (!previous) return;
    if (frame.type === RelayFrameType.CLOSE || frame.type === RelayFrameType.ERROR) {
      previous.peerClosed = true;
      this.#current.delete(key);
      previous.controller.abort();
    } else if (frame.type === RelayFrameType.DATA) {
      try {
        previous.work.receive(frame.payload);
      } catch (error) {
        this.#report(error);
        previous.controller.abort();
      }
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const closing = Promise.withResolvers<void>();
    this.#closing = closing.promise;
    const entries = [...this.#all];
    for (const entry of entries) entry.controller.abort();
    void Promise.allSettled(entries.map((entry) => entry.work.finished)).then(() => {
      this.#current.clear();
      this.#all.clear();
      closing.resolve();
    });
    return this.#closing;
  }

  #report(error: unknown): void {
    try {
      this.input.observeFailure(error);
    } catch {
      /* Diagnostics do not own sessions. */
    }
  }
}

interface Entry {
  controller: AbortController;
  work: RelaySessionWork;
  peerClosed: boolean;
}

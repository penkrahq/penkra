const MAX_BUFFERED_EVENTS_PER_NAME = 16;

export class AppFrameEventRouter {
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #backlog = new Map<string, unknown[]>();

  add(name: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);

    const pending = this.#backlog.get(name);
    if (pending) {
      this.#backlog.delete(name);
      for (const payload of pending) listener(payload);
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(name);
    };
  }

  deliver(name: string, payload: unknown): void {
    const listeners = this.#listeners.get(name);
    if (listeners?.size) {
      for (const listener of listeners) listener(payload);
      return;
    }

    const pending = this.#backlog.get(name) ?? [];
    pending.push(payload);
    if (pending.length > MAX_BUFFERED_EVENTS_PER_NAME) pending.shift();
    this.#backlog.set(name, pending);
  }
}

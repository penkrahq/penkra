// FILE: protectedPublisher.ts
// Purpose: Isolates post-commit observers from the operations they observe.
// Layer: Trusted desktop App runtime

export type ProtectedListener<Event> = (event: Event) => void | Promise<void>;

export class ProtectedPublisher<Event> {
  readonly #listeners = new Set<ProtectedListener<Event>>();
  readonly #onFailure: (error: unknown) => void | Promise<void>;

  constructor(onFailure: (error: unknown) => void | Promise<void>) {
    this.#onFailure = onFailure;
  }

  subscribe(listener: ProtectedListener<Event>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: Event): void {
    for (const listener of this.#listeners) {
      try {
        Promise.resolve(listener(event)).catch((error) => this.#report(error));
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      Promise.resolve(this.#onFailure(error)).catch(() => undefined);
    } catch {
      // The terminal sink is deliberately the end of the notification chain.
    }
  }
}

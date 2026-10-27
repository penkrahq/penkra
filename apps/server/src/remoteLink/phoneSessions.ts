/** Tracks actual authenticated sessions, independently of which Thread they view. */
export class RemotePhoneSessions {
  readonly #phones = new Map<string, Set<string>>();
  readonly #listeners = new Set<() => void>();

  connected(phoneId: string): boolean {
    return (this.#phones.get(phoneId)?.size ?? 0) > 0;
  }

  open(phoneId: string, sessionId: string): void {
    let sessions = this.#phones.get(phoneId);
    if (!sessions) this.#phones.set(phoneId, (sessions = new Set()));
    const wasConnected = sessions.size > 0;
    sessions.add(sessionId);
    if (!wasConnected) this.#publish();
  }

  close(phoneId: string, sessionId: string): void {
    const sessions = this.#phones.get(phoneId);
    if (!sessions?.delete(sessionId) || sessions.size) return;
    this.#phones.delete(phoneId);
    this.#publish();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #publish(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Observers do not own sessions. */
      }
    }
  }
}

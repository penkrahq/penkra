/** Viewing is session-owned: closing one session cannot hide another session. */
export class RemoteViewingState {
  readonly #sessions = new Map<string, { phoneId: string; threadId: string }>();

  set(phoneId: string, sessionId: string, threadId: string | null): void {
    if (threadId === null) this.#sessions.delete(sessionId);
    else this.#sessions.set(sessionId, { phoneId, threadId });
  }

  viewing(phoneId: string, threadId: string): boolean {
    return [...this.#sessions.values()].some(
      (session) => session.phoneId === phoneId && session.threadId === threadId,
    );
  }

  clear(): void {
    this.#sessions.clear();
  }
}

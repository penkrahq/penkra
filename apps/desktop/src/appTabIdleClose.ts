// Orders selection against the desktop's authorization of an idle-close write.
export class AppTabIdleClose {
  readonly #pending = new Map<
    string,
    {
      cancelled: boolean;
      submitted: boolean;
      result: Promise<boolean>;
    }
  >();

  select(tabId: string): Promise<void> | undefined {
    const pending = this.#pending.get(tabId);
    if (!pending) return;
    if (pending.submitted) return pending.result.then(() => undefined);
    else pending.cancelled = true;
  }

  async close(
    tabId: string,
    write: (authorize: () => boolean) => Promise<boolean>,
  ): Promise<boolean> {
    const existing = this.#pending.get(tabId);
    if (existing) return existing.result;
    const pending = { cancelled: false, submitted: false, result: Promise.resolve(false) };
    this.#pending.set(tabId, pending);
    pending.result = Promise.resolve().then(() =>
      write(() => {
        if (pending.cancelled) return false;
        pending.submitted = true;
        return true;
      }),
    );
    try {
      return await pending.result;
    } finally {
      if (this.#pending.get(tabId) === pending) this.#pending.delete(tabId);
    }
  }
}

/** Applies an explicit account-owned access choice, registering before enable. */
export class RemoteAccessController {
  #active: AbortController | undefined;
  #revision = 0;

  constructor(
    private readonly input: {
      account: () => Promise<string | null>;
      register: (accountId: string, signal: AbortSignal) => Promise<unknown>;
      setAccess: (accountId: string, enabled: boolean) => Promise<void>;
      signal: AbortSignal;
    },
  ) {}

  async setEnabled(enabled: boolean): Promise<void> {
    const revision = ++this.#revision;
    this.#active?.abort();
    const controller = new AbortController();
    this.#active = controller;
    const signal = AbortSignal.any([controller.signal, this.input.signal]);
    try {
      const accountId = await this.input.account();
      if (!accountId) throw new Error("Sign in to Penkra before changing iPhone access.");
      if (signal.aborted || revision !== this.#revision)
        throw new Error("iPhone access change cancelled.");
      if (enabled) await this.input.register(accountId, signal);
      if (signal.aborted || revision !== this.#revision)
        throw new Error("iPhone access change cancelled.");
      await this.input.setAccess(accountId, enabled);
    } finally {
      if (this.#active === controller) this.#active = undefined;
    }
  }
}

import type { RemoteLifecycleEvent, RemoteLifecycleSnapshot } from "@penkra/contracts";

/** The account is published only after old work is joined; stale reads cannot reopen it. */
export class RemoteAccountCoordinator {
  #generation = 0;
  #accessGeneration = 0;
  #snapshot: RemoteLifecycleSnapshot;

  constructor(
    private readonly input: {
      accountServiceUrl: string;
      readAccess: (accountId: string) => Promise<boolean>;
      writeAccess: (accountId: string, accessOn: boolean) => Promise<void>;
      transition: (
        event: Exclude<RemoteLifecycleEvent["event"], "snapshot">,
        snapshot: RemoteLifecycleSnapshot,
      ) => Promise<void>;
    },
  ) {
    this.#snapshot = {
      accountServiceUrl: input.accountServiceUrl,
      accountId: null,
      accessOn: false,
      suspended: false,
    };
  }

  async initialize(readAccount: () => Promise<string | null>): Promise<void> {
    const generation = ++this.#generation;
    const accountId = await readAccount();
    if (generation !== this.#generation || !accountId) return;
    await this.#publish(accountId, generation);
  }

  async afterSignIn(accountId: string): Promise<void> {
    const generation = ++this.#generation;
    await this.#publish(accountId, generation);
  }

  async beforeAccountChange(): Promise<void> {
    this.#generation++;
    this.#snapshot = { ...this.#snapshot, accountId: null, accessOn: false };
    await this.input.transition("sign-out", this.#snapshot);
  }

  async setSuspended(suspended: boolean): Promise<void> {
    this.#snapshot = { ...this.#snapshot, suspended };
    await this.input.transition(suspended ? "suspend" : "wake", this.#snapshot);
  }

  async networkPathChanged(): Promise<void> {
    await this.input.transition("network-path", this.#snapshot);
  }

  async setAccess(accountId: string, accessOn: boolean): Promise<void> {
    if (this.#snapshot.accountId !== accountId) throw new Error("The signed-in account changed.");
    const accountGeneration = this.#generation;
    const accessGeneration = ++this.#accessGeneration;
    await this.input.writeAccess(accountId, accessOn);
    if (accountGeneration !== this.#generation || accessGeneration !== this.#accessGeneration)
      return;
    this.#snapshot = { ...this.#snapshot, accessOn };
    await this.input.transition("access", this.#snapshot);
  }

  async #publish(accountId: string, generation: number): Promise<void> {
    const accessOn = await this.input.readAccess(accountId);
    if (generation !== this.#generation) return;
    this.#snapshot = { ...this.#snapshot, accountId, accessOn };
    await this.input.transition("sign-in", this.#snapshot);
  }
}

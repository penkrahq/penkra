// FILE: deferredAppTabHost.ts
// Purpose: Lets the trusted runtime start before the shell binds its right-dock App tab owner.
// Layer: Trusted desktop App runtime

import type { AppTabHost, OpenAppTabRequest } from "./appOperationBroker";

export class DeferredAppTabHost implements AppTabHost {
  #host: AppTabHost | null = null;

  bind(host: AppTabHost): () => void {
    if (this.#host) throw new Error("An App tab host is already bound.");
    this.#host = host;
    return () => {
      if (this.#host === host) this.#host = null;
    };
  }

  async open(input: OpenAppTabRequest) {
    return this.#requireHost().open(input);
  }

  async openForResult<Result = unknown>(input: OpenAppTabRequest): Promise<Result> {
    return this.#requireHost().openForResult<Result>(input);
  }

  #requireHost(): AppTabHost {
    if (!this.#host) {
      throw Object.assign(new Error("The Penkra App tab host is not ready."), {
        code: "TAB_HOST_UNAVAILABLE",
      });
    }
    return this.#host;
  }
}

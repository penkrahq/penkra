// FILE: appRendererIdentityStore.ts
// Purpose: Owns exact renderer-generation identity authority for Runtime v2 Apps.
// Layer: Trusted desktop App capability boundary

import type { AppTabGenerationOwner } from "./electronAppTabHost";

export interface AppRendererIdentity {
  appId: string;
  spaceId: string;
  threadId?: string;
  tabId?: string;
}

export class AppRendererIdentityStore {
  readonly #records = new Map<number, AppRendererIdentity>();

  register(rendererId: number, identity: AppRendererIdentity): () => void {
    if (this.#records.has(rendererId)) {
      throw new Error(`App renderer identity ${rendererId} is already registered.`);
    }
    this.#records.set(rendererId, identity);
    return () => {
      if (this.#records.get(rendererId) === identity) this.#records.delete(rendererId);
    };
  }

  get(rendererId: number): AppRendererIdentity | null {
    return this.#records.get(rendererId) ?? null;
  }

  detachGeneration(owner: AppTabGenerationOwner): void {
    const identity = this.#records.get(owner.rendererId);
    if (
      identity?.appId !== owner.appId ||
      identity.spaceId !== owner.spaceId ||
      identity.threadId !== owner.threadId ||
      identity.tabId !== owner.tabId
    ) {
      return;
    }
    this.#records.delete(owner.rendererId);
  }

  clear(): void {
    this.#records.clear();
  }
}

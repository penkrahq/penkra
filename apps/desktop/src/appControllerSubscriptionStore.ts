// FILE: appControllerSubscriptionStore.ts
// Purpose: Owns controller subscriptions for a precise App tab renderer generation.
// Layer: Trusted desktop App capability boundary
import type { AppTabGenerationOwner, AppTabLogicalOwner } from "./appTabViewHost";

export class AppControllerSubscriptionStore {
  readonly #records = new Map<
    string,
    { owner: AppTabGenerationOwner; controller: AbortController }
  >();
  add(id: string, owner: AppTabGenerationOwner): AbortController {
    if (this.#records.has(id)) throw new Error("App subscription already exists.");
    const controller = new AbortController();
    this.#records.set(id, { owner, controller });
    return controller;
  }
  take(id: string, owner: AppTabGenerationOwner): AbortController | null {
    const record = this.#records.get(id);
    if (!record || !sameOwner(record.owner, owner) || record.owner.rendererId !== owner.rendererId)
      return null;
    this.#records.delete(id);
    return record.controller;
  }
  closeGeneration(owner: AppTabGenerationOwner): void {
    this.#close((record) => sameOwner(record, owner) && record.rendererId === owner.rendererId);
  }
  closeTab(owner: AppTabLogicalOwner): void {
    this.#close((record) => sameOwner(record, owner));
  }
  closeScope(appId: string, spaceId: string): void {
    this.#close((owner) => owner.appId === appId && owner.spaceId === spaceId);
  }
  closeAll(): void {
    this.#close(() => true);
  }
  #close(matches: (owner: AppTabGenerationOwner) => boolean): void {
    for (const [id, record] of this.#records) {
      if (!matches(record.owner)) continue;
      this.#records.delete(id);
      record.controller.abort(new Error("App subscription owner closed."));
    }
  }
}
function sameOwner(a: AppTabLogicalOwner, b: AppTabLogicalOwner): boolean {
  return (
    a.appId === b.appId &&
    a.spaceId === b.spaceId &&
    a.folderId === b.folderId &&
    a.threadId === b.threadId &&
    a.tabId === b.tabId
  );
}

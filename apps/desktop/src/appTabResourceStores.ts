// FILE: appTabResourceStores.ts
// Purpose: Owns App tab/generation resources that were previously bare main-process maps.
// Layer: Trusted desktop App capability boundary

import type * as FS from "node:fs";

import type { AppTabGenerationOwner, AppTabLogicalOwner } from "./electronAppTabHost";

const detachedFileWatchesBrand: unique symbol = Symbol("DetachedFileWatches");
const detachedAccountSubscriptionsBrand: unique symbol = Symbol("DetachedAccountSubscriptions");
const detachedSimulatorSurfaceBrand: unique symbol = Symbol("DetachedSimulatorSurface");

export interface AppFileWatchRecord extends AppTabGenerationOwner {
  watcher: FS.FSWatcher;
}

export interface DetachedFileWatches {
  readonly [detachedFileWatchesBrand]: true;
  readonly records: readonly AppFileWatchRecord[];
}

export class AppFileWatchStore {
  readonly #records = new Map<string, AppFileWatchRecord>();

  set(id: string, record: AppFileWatchRecord): void {
    if (this.#records.has(id)) throw new Error(`App file watch ${id} is already registered.`);
    this.#records.set(id, record);
  }

  take(id: string, owner: AppTabGenerationOwner): FS.FSWatcher | null {
    const record = this.#records.get(id);
    if (!record || !sameGeneration(record, owner)) return null;
    this.#records.delete(id);
    return record.watcher;
  }

  detachGeneration(owner: AppTabGenerationOwner): DetachedFileWatches {
    return this.#detach((record) => sameGeneration(record, owner));
  }

  detachTab(owner: AppTabLogicalOwner): DetachedFileWatches {
    return this.#detach((record) => sameTab(record, owner));
  }

  detachScope(appId: string, spaceId: string): DetachedFileWatches {
    return this.#detach((record) => record.appId === appId && record.spaceId === spaceId);
  }

  detachAll(): DetachedFileWatches {
    return this.#detach(() => true);
  }

  disposeDetached(detached: DetachedFileWatches): void {
    const failures: unknown[] = [];
    for (const record of detached.records) {
      try {
        record.watcher.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "App file-watch disposal failed.");
  }

  #detach(predicate: (record: AppFileWatchRecord) => boolean): DetachedFileWatches {
    const records: AppFileWatchRecord[] = [];
    for (const [id, record] of this.#records) {
      if (!predicate(record)) continue;
      records.push(record);
      this.#records.delete(id);
    }
    return { [detachedFileWatchesBrand]: true, records };
  }
}

export type AccountSubscriptionOwner =
  | { kind: "web-contents"; webContentsId: number }
  | {
      kind: "app-generation";
      appId: string;
      spaceId: string;
      threadId: string;
      tabId: string;
      rendererId: number;
    };

export interface AppAccountSubscriptionRecord {
  owner: AccountSubscriptionOwner;
  stop(): void;
}

export interface DetachedAccountSubscriptions {
  readonly [detachedAccountSubscriptionsBrand]: true;
  readonly records: readonly AppAccountSubscriptionRecord[];
}

export class AppAccountSubscriptionStore {
  readonly #records = new Map<string, AppAccountSubscriptionRecord>();

  set(id: string, record: AppAccountSubscriptionRecord): void {
    if (this.#records.has(id)) throw new Error(`App account subscription ${id} already exists.`);
    this.#records.set(id, record);
  }

  take(id: string, owner: AccountSubscriptionOwner): AppAccountSubscriptionRecord | null {
    const record = this.#records.get(id);
    if (!record || !sameSubscriptionOwner(record.owner, owner)) return null;
    this.#records.delete(id);
    return record;
  }

  detachGeneration(owner: AppTabGenerationOwner): DetachedAccountSubscriptions {
    return this.#detach(
      (record) => record.owner.kind === "app-generation" && sameGeneration(record.owner, owner),
    );
  }

  detachWebContents(webContentsId: number): DetachedAccountSubscriptions {
    return this.#detach(
      (record) =>
        record.owner.kind === "web-contents" && record.owner.webContentsId === webContentsId,
    );
  }

  detachTab(owner: AppTabLogicalOwner): DetachedAccountSubscriptions {
    return this.#detach(
      (record) => record.owner.kind === "app-generation" && sameTab(record.owner, owner),
    );
  }

  detachAll(): DetachedAccountSubscriptions {
    return this.#detach(() => true);
  }

  disposeDetached(detached: DetachedAccountSubscriptions): void {
    const failures: unknown[] = [];
    for (const record of detached.records) {
      try {
        record.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "App account-subscription disposal failed.");
    }
  }

  #detach(
    predicate: (record: AppAccountSubscriptionRecord) => boolean,
  ): DetachedAccountSubscriptions {
    const records: AppAccountSubscriptionRecord[] = [];
    for (const [id, record] of this.#records) {
      if (!predicate(record)) continue;
      records.push(record);
      this.#records.delete(id);
    }
    return { [detachedAccountSubscriptionsBrand]: true, records };
  }
}

export interface AppSimulatorSurfaceRecord {
  stopFrames: (() => void) | null;
  generation: number;
}

export interface DetachedSimulatorSurface {
  readonly [detachedSimulatorSurfaceBrand]: true;
  readonly record: AppSimulatorSurfaceRecord | null;
}

export class AppSimulatorSurfaceStore {
  readonly #records = new Map<string, AppSimulatorSurfaceRecord>();

  get(tabId: string): AppSimulatorSurfaceRecord | undefined {
    return this.#records.get(tabId);
  }

  set(tabId: string, record: AppSimulatorSurfaceRecord): void {
    this.#records.set(tabId, record);
  }

  delete(tabId: string): boolean {
    return this.#records.delete(tabId);
  }

  detachTab(owner: Pick<AppTabLogicalOwner, "tabId">): DetachedSimulatorSurface {
    const record = this.#records.get(owner.tabId) ?? null;
    this.#records.delete(owner.tabId);
    return { [detachedSimulatorSurfaceBrand]: true, record };
  }

  disposeDetached(detached: DetachedSimulatorSurface): void {
    detached.record?.stopFrames?.();
  }
}

export interface AppBrowserSurfaceInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export class AppBrowserSurfaceInsetStore {
  readonly #records = new Map<string, AppBrowserSurfaceInsets>();

  get(tabId: string): AppBrowserSurfaceInsets | undefined {
    return this.#records.get(tabId);
  }

  has(tabId: string): boolean {
    return this.#records.has(tabId);
  }

  set(tabId: string, insets: AppBrowserSurfaceInsets): void {
    this.#records.set(tabId, insets);
  }

  delete(tabId: string): boolean {
    return this.#records.delete(tabId);
  }

  detachTab(owner: Pick<AppTabLogicalOwner, "tabId">): void {
    this.#records.delete(owner.tabId);
  }
}

function sameGeneration(
  left: Pick<AppTabGenerationOwner, "appId" | "spaceId" | "threadId" | "tabId" | "rendererId">,
  right: AppTabGenerationOwner,
): boolean {
  return sameTab(left, right) && left.rendererId === right.rendererId;
}

function sameTab(
  left: Pick<AppTabLogicalOwner, "appId" | "spaceId" | "threadId" | "tabId">,
  right: AppTabLogicalOwner,
): boolean {
  return (
    left.appId === right.appId &&
    left.spaceId === right.spaceId &&
    left.threadId === right.threadId &&
    left.tabId === right.tabId
  );
}

function sameSubscriptionOwner(
  left: AccountSubscriptionOwner,
  right: AccountSubscriptionOwner,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "web-contents"
    ? left.webContentsId ===
        (right as Extract<AccountSubscriptionOwner, { kind: "web-contents" }>).webContentsId
    : sameGeneration(left, right as Extract<AccountSubscriptionOwner, { kind: "app-generation" }>);
}

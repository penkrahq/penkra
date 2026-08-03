// FILE: desktopComposerDraftStorage.ts
// Purpose: Routes composer snapshots through the crash-durable desktop journal.
// Layer: Renderer storage adapter

import type { StateStorage } from "./storage";

let desktopComposerDraftWrites = Promise.resolve();

export function awaitDesktopComposerDraftWrites(): Promise<void> {
  return desktopComposerDraftWrites;
}

export function createDesktopComposerDraftStorage(fallback: StateStorage): StateStorage {
  const bridge = window.desktopBridge?.composerDrafts;
  if (!bridge) return fallback;

  let writes = Promise.resolve();
  const enqueue = (operation: () => Promise<void>): void => {
    writes = writes.then(operation, operation).catch((error: unknown) => {
      console.error("[composer-drafts] Durable desktop checkpoint failed.", error);
      throw error;
    });
    desktopComposerDraftWrites = writes;
  };

  return {
    getItem: async (name) => {
      await writes;
      const durable = await bridge.readSnapshot().catch((error: unknown) => {
        console.error("[composer-drafts] Could not read the durable desktop snapshot.", error);
        return null;
      });
      if (durable !== null) return durable;
      const fallbackValue = await fallback.getItem(name);
      if (fallbackValue !== null) enqueue(() => bridge.writeSnapshot(fallbackValue));
      return fallbackValue;
    },
    setItem: (name, value) => {
      enqueue(() => bridge.writeSnapshot(value));
      try {
        const fallbackWrite = fallback.setItem(name, value);
        if (fallbackWrite instanceof Promise) void fallbackWrite.catch(() => undefined);
      } catch {
        // The main-process journal is authoritative on desktop. A localStorage
        // quota failure must not prevent its checkpoint from being queued.
      }
    },
    removeItem: (name) => {
      enqueue(() => bridge.removeSnapshot());
      try {
        const fallbackRemoval = fallback.removeItem(name);
        if (fallbackRemoval instanceof Promise) void fallbackRemoval.catch(() => undefined);
      } catch {
        // Keep removing from the authoritative journal.
      }
    },
  };
}

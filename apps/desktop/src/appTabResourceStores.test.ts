import { describe, expect, it, vi } from "vitest";

import { AppAccountSubscriptionStore, AppFileWatchStore } from "./appTabResourceStores";

const generation = {
  appId: "com.acme.app",
  spaceId: "personal",
  threadId: "thread-1",
  tabId: "tab-1",
  rendererId: -1,
};

describe("App tab resource stores", () => {
  it("removes file-watch authority before fallible disposal and matches the full generation", () => {
    const store = new AppFileWatchStore();
    const close = vi.fn(() => {
      throw new Error("watcher close failed");
    });
    store.set("watch-1", { ...generation, watcher: { close } as never });

    const wrong = store.detachGeneration({ ...generation, rendererId: -2 });
    store.disposeDetached(wrong);
    expect(store.take("watch-1", generation)).not.toBeNull();

    store.set("watch-2", { ...generation, watcher: { close } as never });
    const detached = store.detachGeneration(generation);
    expect(store.take("watch-2", generation)).toBeNull();
    expect(() => store.disposeDetached(detached)).toThrow("file-watch disposal failed");
    expect(store.take("watch-2", generation)).toBeNull();
  });

  it("keeps WebContents subscriptions separate from App generations", () => {
    const store = new AppAccountSubscriptionStore();
    const stopWebContents = vi.fn();
    const stopGeneration = vi.fn();
    store.set("web", {
      owner: { kind: "web-contents", webContentsId: 17 },
      stop: stopWebContents,
    });
    store.set("generation", {
      owner: { kind: "app-generation", ...generation },
      stop: stopGeneration,
    });

    store.disposeDetached(store.detachGeneration(generation));
    expect(stopGeneration).toHaveBeenCalledOnce();
    expect(stopWebContents).not.toHaveBeenCalled();
    expect(store.take("web", { kind: "web-contents", webContentsId: 17 })).not.toBeNull();
  });
});

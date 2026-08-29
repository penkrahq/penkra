import { describe, expect, it } from "vitest";

import { AppRendererIdentityStore } from "./appRendererIdentityStore";

describe("AppRendererIdentityStore", () => {
  it("rejects duplicate identities and releases only the exact registered value", () => {
    const store = new AppRendererIdentityStore();
    const identity = {
      appId: "com.acme.app",
      spaceId: "personal",
      threadId: "thread-1",
      tabId: "tab-1",
    };
    const release = store.register(-1, identity);
    expect(() => store.register(-1, { ...identity })).toThrow("already registered");
    expect(store.get(-1)).toBe(identity);
    release();
    release();
    expect(store.get(-1)).toBeNull();
  });

  it("detaches only a matching full generation owner", () => {
    const store = new AppRendererIdentityStore();
    store.register(-1, {
      appId: "com.acme.app",
      spaceId: "personal",
      threadId: "thread-1",
      tabId: "tab-1",
    });
    store.detachGeneration({
      appId: "com.acme.app",
      spaceId: "personal",
      threadId: "thread-1",
      tabId: "tab-1",
      rendererId: -2,
    });
    expect(store.get(-1)).not.toBeNull();
    store.detachGeneration({
      appId: "com.acme.app",
      spaceId: "personal",
      threadId: "thread-1",
      tabId: "tab-1",
      rendererId: -1,
    });
    expect(store.get(-1)).toBeNull();
  });
});

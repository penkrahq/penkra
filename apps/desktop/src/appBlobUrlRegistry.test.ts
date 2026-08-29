import { describe, expect, it } from "vitest";

import { AppBlobUrlRegistry } from "./appBlobUrlRegistry";

const owner = {
  appId: "com.example.video",
  spaceId: "space-1",
  threadId: "thread-1",
  tabId: "tab-1",
  rendererId: 7,
  origin: `penkra-app://a-${"a".repeat(64)}`,
};

describe("AppBlobUrlRegistry", () => {
  it("mints origin-bound URLs and lets only the creating tab revoke them", () => {
    const registry = new AppBlobUrlRegistry();
    const url = registry.open(owner, "/tmp/movie.mp4");
    const token = new URL(url).pathname.split("/").at(-1)!;

    expect(registry.resolve(owner.origin, token).path).toBe("/tmp/movie.mp4");
    expect(() => registry.resolve(`penkra-app://a-${"b".repeat(64)}`, token)).toThrow(
      "unavailable",
    );
    expect(() => registry.close({ ...owner, tabId: "tab-2" }, url)).toThrow("unavailable");
    registry.close(owner, url);
    expect(() => registry.resolve(owner.origin, token)).toThrow("unavailable");
  });

  it("releases all URLs owned by a closing renderer", () => {
    const registry = new AppBlobUrlRegistry();
    const first = registry.open(owner, "/tmp/one");
    const second = registry.open({ ...owner, rendererId: 8 }, "/tmp/two");
    registry.disposeDetached(registry.detachGeneration(owner));

    expect(() =>
      registry.resolve(owner.origin, new URL(first).pathname.split("/").at(-1)!),
    ).toThrow();
    expect(registry.resolve(owner.origin, new URL(second).pathname.split("/").at(-1)!).path).toBe(
      "/tmp/two",
    );
  });
});

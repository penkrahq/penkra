import { describe, expect, it } from "vitest";

import { AppBlobUrlRegistry } from "./appBlobUrlRegistry";

const owner = {
  appId: "com.example.video",
  spaceId: "space-1",
  folderId: "folder-1",
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
});

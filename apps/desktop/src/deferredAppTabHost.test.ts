import { describe, expect, it, vi } from "vitest";

import { DeferredAppTabHost } from "./deferredAppTabHost";

const request = {
  app: {
    appId: "com.acme.linear",
    slug: "linear",
    name: "Linear",
    summary: "Manage issues.",
    version: "1.0.0",
    source: "registry" as const,
    packagePath: "/apps/linear",
    sha256: "a".repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
    manifest: {
      id: "com.acme.linear",
      slug: "linear",
      name: "Linear",
      summary: "Manage issues.",
      version: "1.0.0",
      compatibility: { penkra: ">=0.8.0" },
      icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
      entrypoints: { tab: "app.html" },
    },
  },
  spaceId: "personal",
  threadId: "thread-1",
  route: "/issues/new",
};

describe("DeferredAppTabHost", () => {
  it("fails explicitly until the shell tab owner binds", async () => {
    const tabs = new DeferredAppTabHost();
    await expect(tabs.open(request)).rejects.toMatchObject({ code: "TAB_HOST_UNAVAILABLE" });
  });

  it("forwards to only the currently bound host", async () => {
    const tabs = new DeferredAppTabHost();
    const open = vi.fn(async () => ({ id: "tab-1" }));
    const openForResult = vi.fn(async () => ({ saved: true }));
    const unbind = tabs.bind({ open: open as never, openForResult: openForResult as never });

    await tabs.open(request);
    await tabs.openForResult(request);
    expect(open).toHaveBeenCalledWith(request);
    expect(openForResult).toHaveBeenCalledWith(request);
    expect(() => tabs.bind({ open: open as never, openForResult: openForResult as never })).toThrow(
      "already bound",
    );
    unbind();
    await expect(tabs.open(request)).rejects.toMatchObject({ code: "TAB_HOST_UNAVAILABLE" });
  });
});

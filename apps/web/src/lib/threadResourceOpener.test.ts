import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@penkra/contracts";

import { createThreadResourceOpener, resolveThreadResourcePath } from "./threadResourceOpener";

describe("resolveThreadResourcePath", () => {
  it("keeps absolute paths and removes line suffixes", () => {
    expect(resolveThreadResourcePath("/workspace/src/main.ts:12:4", "/workspace")).toBe(
      "/workspace/src/main.ts",
    );
  });

  it("resolves safe paths relative to the Thread directory", () => {
    expect(resolveThreadResourcePath("docs/readme.md", "/workspace/project/")).toBe(
      "/workspace/project/docs/readme.md",
    );
  });

  it("rejects relative paths without a Thread directory and traversal", () => {
    expect(resolveThreadResourcePath("readme.md", null)).toBeNull();
    expect(resolveThreadResourcePath("../secret.txt", "/workspace/project")).toBeNull();
  });
});

describe("createThreadResourceOpener", () => {
  it("routes files and URLs through the desktop resource bridge", () => {
    const open = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge: { resources: { open } } },
    });
    const opener = createThreadResourceOpener({
      directory: "/workspace/project",
      spaceId: "space-1",
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(opener.openFile("README.md")).toBe(true);
    expect(opener.openUrl("https://penkra.com/docs")).toBe(true);
    expect(open).toHaveBeenNthCalledWith(1, {
      path: "/workspace/project/README.md",
      spaceId: "space-1",
      threadId: "thread-1",
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      url: "https://penkra.com/docs",
      spaceId: "space-1",
      threadId: "thread-1",
    });
  });
});

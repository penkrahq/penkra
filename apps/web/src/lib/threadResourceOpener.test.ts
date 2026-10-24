import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId, FolderId } from "@penkra/contracts";

import {
  createThreadResourceOpener,
  resolveThreadResourcePath,
  openThreadAttachmentReference,
} from "./threadResourceOpener";
import { toastManager } from "../components/ui/toast";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openThreadAttachmentReference", () => {
  it("resolves the saved attachment and uses the normal opener without a forced destination", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:5555?token=secret",
        resources: { open },
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ path: "/state/attachments/objects/report.pdf" }));
    vi.stubGlobal("fetch", fetch);
    const opener = createThreadResourceOpener({
      directory: null,
      spaceId: "space",
      folderId: FolderId.make("folder"),
      threadId: ThreadId.make("thread"),
    });
    await openThreadAttachmentReference(opener, "att_v2_saved");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5555/attachments/att_v2_saved?metadata=1&token=secret",
    );
    expect(open).toHaveBeenCalledExactlyOnceWith({
      path: "/state/attachments/objects/report.pdf",
      spaceId: "space",
      folderId: "folder",
      threadId: "thread",
    });
  });

  it("reports a deleted attachment instead of attempting an open or download", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const openFile = vi.fn();
    const add = vi.spyOn(toastManager, "add");
    await openThreadAttachmentReference(
      { openFile, openUrl: vi.fn(), showFileContextMenu: vi.fn(), showUrlContextMenu: vi.fn() },
      "att_v2_deleted",
    );
    expect(openFile).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not open file" }),
    );
  });
});

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
    const showContextMenu = vi.fn().mockResolvedValue(null);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge: { resources: { open, showContextMenu } } },
    });
    const threadId = ThreadId.make("thread-1");
    const opener = createThreadResourceOpener({
      directory: "/workspace/project",
      spaceId: "space-1",
      folderId: FolderId.make("folder-1"),

      threadId,
    });

    expect(opener.openFile("README.md")).toBe(true);
    expect(opener.openUrl("https://penkra.com/docs")).toBe(true);
    expect(opener.showFileContextMenu("README.md:12", { x: 10, y: 20 })).toBe(true);
    expect(opener.showUrlContextMenu("https://penkra.com/docs", { x: 30, y: 40 })).toBe(true);
    expect(open).toHaveBeenNthCalledWith(1, {
      path: "/workspace/project/README.md",
      spaceId: "space-1",
      folderId: FolderId.make("folder-1"),
      threadId: "thread-1",
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      url: "https://penkra.com/docs",
      spaceId: "space-1",
      folderId: FolderId.make("folder-1"),
      threadId: "thread-1",
    });
    expect(showContextMenu).toHaveBeenNthCalledWith(1, {
      path: "/workspace/project/README.md",
      spaceId: "space-1",
      folderId: FolderId.make("folder-1"),
      threadId: "thread-1",
      position: { x: 10, y: 20 },
    });
    expect(showContextMenu).toHaveBeenNthCalledWith(2, {
      url: "https://penkra.com/docs",
      spaceId: "space-1",
      folderId: FolderId.make("folder-1"),
      threadId: "thread-1",
      position: { x: 30, y: 40 },
    });
  });
});

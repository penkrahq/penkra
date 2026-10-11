import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createAppTabRestoreRequest,
  isAppPaneInSpace,
  isAppTabOutsideFolderSpace,
  shouldMountAppDockPane,
  restoreAppTab,
} from "./appTabRestore.logic";

describe("App tab restoration readiness", () => {
  it("mounts App panes only after the current host confirms their IDs", () => {
    const confirmed = new Set(["current-tab"]);
    expect(shouldMountAppDockPane("current-tab", confirmed)).toBe(true);
    expect(shouldMountAppDockPane("previous-process-tab", confirmed)).toBe(false);
  });

  it("restores a persisted pane under its exact stable tab identity", () => {
    expect(
      createAppTabRestoreRequest(
        {
          id: "stable-tab",
          kind: "app",
          appId: "com.example.canvas",
          appSpaceId: "space-1",
          appSlug: "canvas",
          appName: "Canvas",
          appRoute: "/document/7",
          appState: { page: 3 },
          appStatus: "ready",
        },
        "folder-1",
        "thread-1",
      ),
    ).toEqual({
      tabId: "stable-tab",
      appId: "com.example.canvas",
      spaceId: "space-1",
      folderId: "folder-1",
      threadId: "thread-1",
      route: "/document/7",
      state: { page: 3 },
    });
  });

  it("adopts a native tab retained across renderer reload without opening it again", async () => {
    const pane = {
      id: "stable-tab",
      kind: "app" as const,
      appId: "com.example.canvas",
      appSpaceId: "space-1",
      appSlug: "canvas",
      appName: "Canvas",
      appRoute: "/",
      appStatus: "unloaded" as const,
    };
    const tab: DesktopAppTabDescriptor = {
      id: pane.id,
      appId: pane.appId,
      spaceId: pane.appSpaceId,
      folderId: "folder-1",
      threadId: "thread-1",
      slug: "canvas",
      name: "Canvas",
      rendererId: 12,
      iconDataUrl: null,
      route: "/",
      status: "ready",
    };
    const open = vi.fn(async () => tab);
    await expect(
      restoreAppTab(pane, "folder-1", "another-thread-in-folder", {
        list: async () => [tab],
        open,
      }),
    ).resolves.toBe(tab);
    expect(open).not.toHaveBeenCalled();

    const racingOpen = vi.fn(async () => {
      throw new Error("App tab stable-tab is already open.");
    });
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([tab]);
    await expect(
      restoreAppTab(pane, "folder-1", "thread-1", { list, open: racingOpen }),
    ).resolves.toBe(tab);
    expect(racingOpen).toHaveBeenCalledOnce();
  });

  it("never restores a pane into a different Space", () => {
    const pane = {
      id: "canvas-tab",
      kind: "app" as const,
      appId: "com.example.canvas",
      appSpaceId: "space-1",
      appSlug: "canvas",
      appName: "Canvas",
      appRoute: "/",
      appStatus: "ready" as const,
    };
    expect(isAppPaneInSpace(pane, "space-1")).toBe(true);
    expect(isAppPaneInSpace(pane, "space-2")).toBe(false);
  });

  it("discards only tabs attached to the moved folder's previous Space", () => {
    expect(
      isAppTabOutsideFolderSpace(
        { folderId: "folder-1", threadId: "thread-1", spaceId: "space-1" },
        "folder-1",
        "space-2",
      ),
    ).toBe(true);
    expect(
      isAppTabOutsideFolderSpace(
        { folderId: "folder-1", threadId: "thread-1", spaceId: "space-2" },
        "folder-1",
        "space-2",
      ),
    ).toBe(false);
    expect(
      isAppTabOutsideFolderSpace(
        { folderId: "folder-2", threadId: "thread-2", spaceId: "space-1" },
        "folder-1",
        "space-2",
      ),
    ).toBe(false);
  });
});

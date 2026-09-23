import type { DesktopAppTabDescriptor } from "@penkra/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  APP_TAB_HOST_READY_RETRY_LIMIT,
  createAppTabRestoreRequest,
  isAppPaneInSpace,
  isAppTabOutsideDeckSpace,
  shouldMountAppDockPane,
  shouldRetryAppTabHostReady,
  restoreAppTab,
} from "./appTabRestore.logic";

describe("App tab restoration readiness", () => {
  it("retries only the bounded App-host startup race", () => {
    const notReady = new Error("The App tab host is not ready.");
    expect(shouldRetryAppTabHostReady(notReady, 0)).toBe(true);
    expect(shouldRetryAppTabHostReady(notReady, APP_TAB_HOST_READY_RETRY_LIMIT)).toBe(false);
    expect(shouldRetryAppTabHostReady(new Error("Canvas is not enabled"), 0)).toBe(false);
    expect(shouldRetryAppTabHostReady("The App tab host is not ready.", 0)).toBe(false);
  });

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
        "deck-1",
        "thread-1",
      ),
    ).toEqual({
      tabId: "stable-tab",
      appId: "com.example.canvas",
      spaceId: "space-1",
      deckId: "deck-1",
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
      deckId: "deck-1",
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
      restoreAppTab(pane, "deck-1", "thread-1", { list: async () => [tab], open }),
    ).resolves.toBe(tab);
    expect(open).not.toHaveBeenCalled();

    const racingOpen = vi.fn(async () => {
      throw new Error("App tab stable-tab is already open.");
    });
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([tab]);
    await expect(
      restoreAppTab(pane, "deck-1", "thread-1", { list, open: racingOpen }),
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

  it("discards only tabs attached to the moved deck's previous Space", () => {
    expect(
      isAppTabOutsideDeckSpace(
        { deckId: "deck-1", threadId: "thread-1", spaceId: "space-1" },
        "deck-1",
        "space-2",
      ),
    ).toBe(true);
    expect(
      isAppTabOutsideDeckSpace(
        { deckId: "deck-1", threadId: "thread-1", spaceId: "space-2" },
        "deck-1",
        "space-2",
      ),
    ).toBe(false);
    expect(
      isAppTabOutsideDeckSpace(
        { deckId: "deck-2", threadId: "thread-2", spaceId: "space-1" },
        "deck-1",
        "space-2",
      ),
    ).toBe(false);
  });
});

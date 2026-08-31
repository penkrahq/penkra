import { describe, expect, it } from "vitest";

import {
  APP_TAB_HOST_READY_RETRY_LIMIT,
  createAppTabRestoreRequest,
  isAppPaneInSpace,
  isAppTabOutsideThreadSpace,
  shouldMountAppDockPane,
  shouldRetryAppTabHostReady,
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
        "thread-1",
      ),
    ).toEqual({
      tabId: "stable-tab",
      appId: "com.example.canvas",
      spaceId: "space-1",
      threadId: "thread-1",
      route: "/document/7",
      state: { page: 3 },
    });
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

  it("discards only tabs attached to the moved Thread's previous Space", () => {
    expect(
      isAppTabOutsideThreadSpace(
        { threadId: "thread-1", spaceId: "space-1" },
        "thread-1",
        "space-2",
      ),
    ).toBe(true);
    expect(
      isAppTabOutsideThreadSpace(
        { threadId: "thread-1", spaceId: "space-2" },
        "thread-1",
        "space-2",
      ),
    ).toBe(false);
    expect(
      isAppTabOutsideThreadSpace(
        { threadId: "thread-2", spaceId: "space-1" },
        "thread-1",
        "space-2",
      ),
    ).toBe(false);
  });
});

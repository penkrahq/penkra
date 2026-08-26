import { describe, expect, it } from "vitest";

import {
  APP_TAB_HOST_READY_RETRY_LIMIT,
  createAppTabRestoreRequest,
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
          appSlug: "canvas",
          appName: "Canvas",
          appRoute: "/document/7",
          appState: { page: 3 },
          appStatus: "ready",
        },
        "space-1",
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
});

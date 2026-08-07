import { describe, expect, it } from "vitest";

import {
  APP_TAB_HOST_READY_RETRY_LIMIT,
  shouldMountAppDockPane,
  shouldRetryAppTabHostReady,
} from "./appTabRestore.logic";

describe("App tab restoration readiness", () => {
  it("retries only the bounded native-host startup race", () => {
    const notReady = new Error("The App tab host is not ready.");
    expect(shouldRetryAppTabHostReady(notReady, 0)).toBe(true);
    expect(shouldRetryAppTabHostReady(notReady, APP_TAB_HOST_READY_RETRY_LIMIT)).toBe(false);
    expect(shouldRetryAppTabHostReady(new Error("Canvas is not enabled"), 0)).toBe(false);
    expect(shouldRetryAppTabHostReady("The App tab host is not ready.", 0)).toBe(false);
  });

  it("mounts native App panes only after the current host confirms their IDs", () => {
    const confirmed = new Set(["current-tab"]);
    expect(shouldMountAppDockPane("current-tab", confirmed)).toBe(true);
    expect(shouldMountAppDockPane("previous-process-tab", confirmed)).toBe(false);
  });
});

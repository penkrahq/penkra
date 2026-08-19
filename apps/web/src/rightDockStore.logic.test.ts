import { describe, expect, it } from "vitest";

import {
  closePaneInState,
  createDefaultRightDockState,
  openPaneInState,
  sanitizeRightDockStateByThreadId,
  sanitizeRightDockThreadState,
  setActivePaneInState,
  setDockOpenInState,
  updatePaneInState,
} from "./rightDockStore.logic";

const APP_PANE = {
  paneId: "tab-1",
  kind: "app" as const,
  appId: "com.penkra.explorer",
  appSlug: "explorer",
  appName: "Explorer",
  appRoute: "/",
  appStatus: "ready" as const,
};

describe("App tab state", () => {
  it("opens, activates, updates, and closes App tabs", () => {
    const first = openPaneInState(createDefaultRightDockState(), APP_PANE);
    const second = openPaneInState(first, {
      ...APP_PANE,
      paneId: "tab-2",
      appId: "com.penkra.browser",
      appSlug: "browser",
      appName: "Browser",
    });
    expect(second.open).toBe(true);
    expect(second.activePaneId).toBe("tab-2");
    expect(second.panes.map((pane) => pane.appSlug)).toEqual(["explorer", "browser"]);

    const activated = setActivePaneInState(second, "tab-1");
    const updated = updatePaneInState(activated, "tab-1", {
      appRoute: "/files/readme",
      appState: { documentId: "readme" },
      appStatus: "loading",
    });
    expect(updated.panes[0]?.appRoute).toBe("/files/readme");
    expect(updated.panes[0]?.appState).toEqual({ documentId: "readme" });
    expect(updated.panes[0]?.appStatus).toBe("loading");

    const closed = closePaneInState(updated, "tab-1");
    expect(closed.activePaneId).toBe("tab-2");
    expect(closed.panes).toHaveLength(1);
  });

  it("does not open an empty dock", () => {
    expect(setDockOpenInState(createDefaultRightDockState(), true)).toEqual(
      createDefaultRightDockState(),
    );
  });
});

describe("persisted App tabs", () => {
  it("restores only complete App records", () => {
    const state = sanitizeRightDockThreadState({
      open: true,
      activePaneId: "valid",
      panes: [
        {
          id: "valid",
          kind: "app",
          appId: "com.penkra.explorer",
          appSlug: "explorer",
          appName: "Explorer",
          appRoute: "/",
          appState: { documentId: "doc-1", viewport: { x: 20, y: 40 } },
          appStatus: "ready",
        },
        { id: "unsupported", kind: "unknown" },
      ],
    });
    expect(state.panes.map((pane) => pane.id)).toEqual(["valid"]);
    expect(state.panes[0]?.appState).toEqual({
      documentId: "doc-1",
      viewport: { x: 20, y: 40 },
    });
    expect(state.activePaneId).toBe("valid");
    expect(state.open).toBe(true);
  });

  it("closes malformed or empty state", () => {
    expect(sanitizeRightDockThreadState({ open: true, panes: [{ kind: "app" }] })).toEqual(
      createDefaultRightDockState(),
    );
  });

  it("sanitizes the per-Thread map", () => {
    const result = sanitizeRightDockStateByThreadId({
      thread: {
        open: true,
        activePaneId: "app",
        panes: [
          {
            id: "app",
            kind: "app",
            appId: "com.penkra.apps",
            appSlug: "apps",
            appName: "Apps",
            appRoute: "/",
            appStatus: "ready",
          },
        ],
      },
    });
    expect(result.thread?.panes[0]?.appSlug).toBe("apps");
  });

  it("does not churn state when equivalent reconstructed navigation is received", () => {
    const state = openPaneInState(createDefaultRightDockState(), {
      ...APP_PANE,
      appState: { documentId: "doc-1", selection: ["node-1"] },
    });
    expect(
      updatePaneInState(state, "tab-1", {
        appState: { documentId: "doc-1", selection: ["node-1"] },
      }),
    ).toBe(state);
  });
});

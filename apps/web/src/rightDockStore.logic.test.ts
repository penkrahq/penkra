import { describe, expect, it } from "vitest";

import {
  closePaneInState,
  createDefaultRightDockState,
  openPaneInState,
  setActivePaneInState,
  setDockOpenInState,
  setDockWidthInState,
  updatePaneInState,
} from "./rightDockStore.logic";

const APP_PANE = {
  paneId: "tab-1",
  kind: "app" as const,
  appId: "com.penkra.explorer",
  appSpaceId: "space-1",
  appSlug: "explorer",
  appName: "Explorer",
  appRoute: "/",
  appStatus: "ready" as const,
};

describe("App tab state", () => {
  it("restores App X while preserving App Y selection and a closed dock", () => {
    const withX = openPaneInState(createDefaultRightDockState(), APP_PANE);
    const withY = openPaneInState(withX, { ...APP_PANE, paneId: "app-y" });
    for (const open of [true, false]) {
      const restored = openPaneInState(
        { ...withY, open },
        {
          ...APP_PANE,
          appRendererId: -42,
          preserveSelection: true,
        },
      );
      expect(restored.activePaneId).toBe("app-y");
      expect(restored.open).toBe(open);
      expect(restored.panes[0]?.appRendererId).toBe(-42);
      expect(openPaneInState(restored, APP_PANE).activePaneId).toBe(APP_PANE.paneId);
    }
  });

  it("discovers a retained pane without selecting it or opening its dock", () => {
    const state = createDefaultRightDockState();
    const restored = openPaneInState(state, { ...APP_PANE, preserveSelection: true });
    expect(restored.panes).toHaveLength(1);
    expect(restored.activePaneId).toBeNull();
    expect(restored.open).toBe(false);
  });

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

  it("retains a custom width in the folder state", () => {
    const state = setDockWidthInState(createDefaultRightDockState(), 640);
    expect(state.width).toBe(640);
    expect(setDockWidthInState(state, 640)).toBe(state);
    expect(openPaneInState(state, APP_PANE).width).toBe(640);
  });
});

describe("App tab navigation updates", () => {
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

import { describe, expect, it } from "vitest";
import {
  applyFolderAppTabsInState,
  createDefaultRightDockState,
  setDockWidthInState,
  updatePaneInState,
} from "./rightDockStore.logic";

const pane = {
  id: "tab-1",
  kind: "app" as const,
  appId: "com.penkra.explorer",
  appSpaceId: "space-1",
  appSlug: "explorer",
  appName: "Explorer",
  appRoute: "/",
};

describe("App tab state", () => {
  it("retains a custom width in the folder state", () => {
    const state = setDockWidthInState(createDefaultRightDockState(), 640);
    expect(state.width).toBe(640);
    expect(setDockWidthInState(state, 640)).toBe(state);
    expect(
      applyFolderAppTabsInState(state, { open: true, panes: [pane], activePaneId: pane.id }, {})
        .width,
    ).toBe(640);
  });
  it("applies shared membership and selection while preserving window runtime fields", () => {
    const state = setDockWidthInState(createDefaultRightDockState(), 640);
    const next = applyFolderAppTabsInState(
      state,
      { open: false, panes: [pane], activePaneId: pane.id },
      {
        [pane.id]: { appRendererId: -42, appState: { documentId: "doc-1" }, appStatus: "ready" },
      },
    );
    expect(next).toMatchObject({
      open: false,
      activePaneId: pane.id,
      width: 640,
      panes: [
        { ...pane, appRendererId: -42, appStatus: "ready", appState: { documentId: "doc-1" } },
      ],
    });
    expect(
      applyFolderAppTabsInState(next, { open: false, panes: [], activePaneId: null }, {}).panes,
    ).toEqual([]);
    expect(
      applyFolderAppTabsInState(state, { open: true, panes: [pane], activePaneId: pane.id }, {})
        .panes[0]?.appStatus,
    ).toBe("unloaded");
  });
});

describe("App tab navigation updates", () => {
  it("does not churn state when equivalent reconstructed navigation is received", () => {
    const state = applyFolderAppTabsInState(
      createDefaultRightDockState(),
      { open: true, panes: [pane], activePaneId: pane.id },
      {
        [pane.id]: { appState: { documentId: "doc-1", selection: ["node-1"] } },
      },
    );
    expect(
      updatePaneInState(state, pane.id, {
        appState: { documentId: "doc-1", selection: ["node-1"] },
      }),
    ).toBe(state);
  });
});

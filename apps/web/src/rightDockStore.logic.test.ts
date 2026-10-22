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
    expect(applyFolderAppTabsInState(state, { panes: [pane] }, {}).width).toBe(640);
  });
  it("applies shared membership while preserving window runtime fields", () => {
    const state = setDockWidthInState(createDefaultRightDockState(), 640);
    const next = applyFolderAppTabsInState(
      state,
      { panes: [pane] },
      {
        [pane.id]: { appRendererId: -42, appState: { documentId: "doc-1" }, appStatus: "ready" },
      },
    );
    expect(next).toMatchObject({
      open: false,
      activePaneId: null,
      width: 640,
      panes: [{ ...pane, appRendererId: -42, appStatus: "ready", appState: undefined }],
    });
    expect(applyFolderAppTabsInState(next, { panes: [] }, {}).panes).toEqual([]);
    expect(applyFolderAppTabsInState(state, { panes: [pane] }, {}).panes[0]?.appStatus).toBe(
      "unloaded",
    );
  });
});

describe("App tab navigation updates", () => {
  it("does not churn state when equivalent reconstructed navigation is received", () => {
    const state = applyFolderAppTabsInState(
      createDefaultRightDockState(),
      { panes: [{ ...pane, appState: { documentId: "doc-1", selection: ["node-1"] } }] },
      {},
    );
    expect(
      updatePaneInState(state, pane.id, {
        appState: { documentId: "doc-1", selection: ["node-1"] },
      }),
    ).toBe(state);
  });
});

const second = { ...pane, id: "tab-2" };
const third = { ...pane, id: "tab-3" };
it("keeps two windows' selection and panel visibility independent while sharing closes", () => {
  const shared = { panes: [pane, second, third] };
  const initial = applyFolderAppTabsInState(createDefaultRightDockState(), shared, {});
  expect(initial.activePaneId).toBe(null);
  const a = { ...initial, activePaneId: pane.id, open: true };
  const b = { ...initial, activePaneId: second.id, open: false };
  const nextA = applyFolderAppTabsInState(a, shared, {});
  const nextB = applyFolderAppTabsInState(b, shared, {});
  expect(nextA.activePaneId).toBe(pane.id);
  expect(nextA.open).toBe(true);
  expect(nextB.activePaneId).toBe(second.id);
  expect(nextB.open).toBe(false);
  const closed = { panes: [pane, third] };
  expect(applyFolderAppTabsInState(nextA, closed, {}).panes.map((p) => p.id)).toEqual([
    pane.id,
    third.id,
  ]);
  expect(applyFolderAppTabsInState(nextB, closed, {}).activePaneId).toBe(third.id);
  const lastSelected = { ...nextA, activePaneId: third.id };
  expect(applyFolderAppTabsInState(lastSelected, { panes: [pane, second] }, {}).activePaneId).toBe(
    second.id,
  );
});

it("does not select a background addition to an already loaded empty folder", () => {
  const state = createDefaultRightDockState();
  const next = applyFolderAppTabsInState(state, { panes: [pane] }, {});
  expect(next.activePaneId).toBe(null);
  expect(next.open).toBe(false);
});

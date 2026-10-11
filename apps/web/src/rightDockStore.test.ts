import { beforeEach, expect, it, vi } from "vitest";
import { FolderId, type CleanCoreFolderAppTabsResult } from "@penkra/contracts";
import { applyFolderAppTabs, loadFolderAppTabs, useRightDockStore } from "./rightDockStore";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), toast: vi.fn() }));
vi.mock("./nativeApi", () => ({
  ensureNativeApi: () => ({
    cleanCore: { getFolderAppTabs: mocks.get, updateFolderAppTabs: mocks.update },
  }),
}));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const folderId = FolderId.makeUnsafe("folder");
const pane = {
  id: "tab-x",
  kind: "app" as const,
  appId: "com.penkra.explorer",
  appSpaceId: "space",
  appSlug: "explorer",
  appName: "Explorer",
  appRoute: "/",
};
const row = (updatedAt: string): CleanCoreFolderAppTabsResult => ({
  folderId,
  updatedAt,
  tabs: { panes: [pane] },
});
beforeEach(() => {
  vi.clearAllMocks();
  useRightDockStore.setState({
    dockStateByFolderId: {},
    updatedAtByFolderId: {},
    runtimeByPaneId: {},
  });
});

it("keeps a newer broadcast when an older folder read arrives", async () => {
  let complete!: (row: CleanCoreFolderAppTabsResult) => void;
  mocks.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const load = loadFolderAppTabs(folderId);
  applyFolderAppTabs({
    ...row("2026-10-11T00:00:02.000Z"),
    tabs: { panes: [] },
  });
  complete(row("2026-10-11T00:00:01.000Z"));
  await load;
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.panes).toEqual([]);
});

it("writes only pane fields and selects the opened pane in this window", async () => {
  let complete!: (row: CleanCoreFolderAppTabsResult) => void;
  mocks.update.mockImplementationOnce(
    () =>
      new Promise<CleanCoreFolderAppTabsResult>((done) => {
        complete = done;
      }),
  );
  useRightDockStore.getState().setDockWidth(folderId, 640);
  const opened = useRightDockStore.getState().openPane(folderId, {
    ...pane,
    paneId: pane.id,
    preserveSelection: false,
    appStatus: "ready",
    appRendererId: -42,
    appState: { secret: "runtime" },
  });
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.panes).toEqual([]);
  expect(mocks.update.mock.calls[0]?.[0].update).toEqual({
    action: "open",
    pane,
  });
  complete(row("2026-10-11T00:00:02.000Z"));
  await opened;
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]).toMatchObject({
    activePaneId: pane.id,
    width: 640,
    panes: [{ appRendererId: -42, appStatus: "ready", appState: { secret: "runtime" } }],
  });
});

it("shows a tab-list write failure without changing window selection", async () => {
  const failed = new Promise<void>((resolve) =>
    mocks.toast.mockImplementationOnce(() => resolve()),
  );
  applyFolderAppTabs(row("2026-10-11T00:00:01.000Z"));
  mocks.update.mockRejectedValueOnce(new Error("Folder is unavailable"));
  useRightDockStore.getState().closePane(folderId, pane.id);
  await failed;
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Could not update Apps",
    description: "Folder is unavailable",
  });
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.activePaneId).toBe(pane.id);
});

it("selects and hides locally without writing the folder row", () => {
  applyFolderAppTabs({
    ...row("2026-10-11T00:00:01.000Z"),
    tabs: { panes: [pane, { ...pane, id: "tab-y" }] },
  });
  useRightDockStore.getState().setActivePane(folderId, "tab-y");
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.activePaneId).toBe("tab-y");
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.open).toBe(true);
  useRightDockStore.getState().setDockOpen(folderId, false);
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.open).toBe(false);
  expect(mocks.update).not.toHaveBeenCalled();
});

it("selects the first tab on first read but preserves an empty window's selection on a broadcast", () => {
  applyFolderAppTabs(row("2026-10-11T00:00:01.000Z"));
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.activePaneId).toBe(pane.id);
  applyFolderAppTabs({ ...row("2026-10-11T00:00:02.000Z"), tabs: { panes: [] } });
  applyFolderAppTabs(row("2026-10-11T00:00:03.000Z"));
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.activePaneId).toBe(null);
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.open).toBe(false);
});

it("restores App X while preserving App Y selection and a closed dock", async () => {
  const y = { ...pane, id: "tab-y" };
  const value = { ...row("2026-10-11T00:00:01.000Z"), tabs: { panes: [pane, y] } };
  applyFolderAppTabs(value);
  useRightDockStore.getState().setActivePane(folderId, y.id);
  useRightDockStore.getState().setDockOpen(folderId, false);
  mocks.update.mockResolvedValueOnce({ ...value, updatedAt: "2026-10-11T00:00:02.000Z" });
  await useRightDockStore.getState().openPane(folderId, {
    ...pane,
    paneId: pane.id,
    preserveSelection: true,
    appStatus: "ready",
  });
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.activePaneId).toBe(y.id);
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.open).toBe(false);
});

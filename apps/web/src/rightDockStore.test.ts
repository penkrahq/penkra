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
  tabs: { open: true, activePaneId: pane.id, panes: [pane] },
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
    tabs: { open: false, panes: [], activePaneId: null },
  });
  complete(row("2026-10-11T00:00:01.000Z"));
  await load;
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.panes).toEqual([]);
});

it("writes only persistent pane fields and shows the returned shared selection", async () => {
  let complete!: (row: CleanCoreFolderAppTabsResult) => void;
  const settled = new Promise<void>((resolve) => {
    mocks.update.mockImplementationOnce(
      () =>
        new Promise<CleanCoreFolderAppTabsResult>((done) => {
          complete = (value) => {
            done(value);
            resolve();
          };
        }),
    );
  });
  useRightDockStore.getState().setDockWidth(folderId, 640);
  useRightDockStore.getState().openPane(folderId, {
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
    preserveSelection: false,
  });
  complete(row("2026-10-11T00:00:02.000Z"));
  await settled;
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]).toMatchObject({
    activePaneId: pane.id,
    width: 640,
    panes: [{ appRendererId: -42, appStatus: "ready", appState: { secret: "runtime" } }],
  });
});

it("shows a write failure without changing shared selection", async () => {
  const failed = new Promise<void>((resolve) =>
    mocks.toast.mockImplementationOnce(() => resolve()),
  );
  applyFolderAppTabs(row("2026-10-11T00:00:01.000Z"));
  mocks.update.mockRejectedValueOnce(new Error("Folder is unavailable"));
  useRightDockStore.getState().setDockOpen(folderId, false);
  await failed;
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "Could not update Apps",
    description: "Folder is unavailable",
  });
  expect(useRightDockStore.getState().dockStateByFolderId[folderId]?.open).toBe(true);
});

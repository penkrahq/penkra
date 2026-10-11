import { describe, expect, it, vi } from "vitest";
import { closeSelectedPanelTabForFolder, selectedPanelTabForFolder } from "./panelShortcuts";
import type { RightDockFolderState } from "../rightDockStore.logic";

describe("selectedPanelTabForFolder", () => {
  it("returns only the requested folder's selected App tab", () => {
    const first = {
      open: true,
      activePaneId: "first-tab",
      panes: [{ id: "first-tab", kind: "app" }],
    } as RightDockFolderState;
    const second = {
      open: true,
      activePaneId: "second-tab",
      panes: [{ id: "second-tab", kind: "app" }],
    } as RightDockFolderState;
    expect(selectedPanelTabForFolder(first)).toBe("first-tab");
    expect(selectedPanelTabForFolder(second)).toBe("second-tab");
    expect(selectedPanelTabForFolder({ ...first, open: false })).toBeNull();
    expect(selectedPanelTabForFolder(undefined)).toBeNull();
    const closePane = vi.fn();
    expect(
      closeSelectedPanelTabForFolder({
        folderId: "second-folder",
        state: second,
        closePane,
      }),
    ).toBe("second-tab");
    expect(closePane).toHaveBeenCalledExactlyOnceWith("second-folder", "second-tab");
  });
});

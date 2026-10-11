import type { RightDockFolderState } from "../rightDockStore.logic";

/** A shortcut closes one selected tab in one folder, even when several surfaces are mounted. */
export function selectedPanelTabForFolder(state: RightDockFolderState | undefined): string | null {
  if (!state?.open || !state.activePaneId) return null;
  return state.panes.some((pane) => pane.id === state.activePaneId && pane.kind === "app")
    ? state.activePaneId
    : null;
}

export function closeSelectedPanelTabForFolder(input: {
  folderId: string;
  state: RightDockFolderState | undefined;
  closePane: (folderId: string, paneId: string) => void;
}): string | null {
  const paneId = selectedPanelTabForFolder(input.state);
  if (!paneId) return null;
  input.closePane(input.folderId, paneId);
  return paneId;
}

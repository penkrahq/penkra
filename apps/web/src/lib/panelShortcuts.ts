import type { RightDockDeckState } from "../rightDockStore.logic";

/** A shortcut closes one selected tab in one deck, even when several surfaces are mounted. */
export function selectedPanelTabForDeck(state: RightDockDeckState | undefined): string | null {
  if (!state?.open || !state.activePaneId) return null;
  return state.panes.some((pane) => pane.id === state.activePaneId && pane.kind === "app")
    ? state.activePaneId
    : null;
}

export function closeSelectedPanelTabForDeck(input: {
  deckId: string;
  state: RightDockDeckState | undefined;
  closeNativeTab: (tabId: string) => void;
  closePane: (deckId: string, paneId: string) => void;
}): string | null {
  const paneId = selectedPanelTabForDeck(input.state);
  if (!paneId) return null;
  input.closeNativeTab(paneId);
  input.closePane(input.deckId, paneId);
  return paneId;
}

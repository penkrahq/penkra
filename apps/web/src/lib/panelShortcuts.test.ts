import { describe, expect, it, vi } from "vitest";
import { closeSelectedPanelTabForDeck, selectedPanelTabForDeck } from "./panelShortcuts";
import type { RightDockDeckState } from "../rightDockStore.logic";

describe("selectedPanelTabForDeck", () => {
  it("returns only the requested deck's selected App tab", () => {
    const first = {
      open: true,
      activePaneId: "first-tab",
      panes: [{ id: "first-tab", kind: "app" }],
    } as RightDockDeckState;
    const second = {
      open: true,
      activePaneId: "second-tab",
      panes: [{ id: "second-tab", kind: "app" }],
    } as RightDockDeckState;
    expect(selectedPanelTabForDeck(first)).toBe("first-tab");
    expect(selectedPanelTabForDeck(second)).toBe("second-tab");
    expect(selectedPanelTabForDeck({ ...first, open: false })).toBeNull();
    expect(selectedPanelTabForDeck(undefined)).toBeNull();
    const closeNativeTab = vi.fn();
    const closePane = vi.fn();
    expect(
      closeSelectedPanelTabForDeck({
        deckId: "second-deck",
        state: second,
        closeNativeTab,
        closePane,
      }),
    ).toBe("second-tab");
    expect(closeNativeTab).toHaveBeenCalledExactlyOnceWith("second-tab");
    expect(closePane).toHaveBeenCalledExactlyOnceWith("second-deck", "second-tab");
  });
});

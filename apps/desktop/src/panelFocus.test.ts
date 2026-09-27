import { describe, expect, it } from "vitest";

import { PanelFocusState } from "./panelFocus";

describe("PanelFocusState", () => {
  it("tracks independent windows and only changes on interaction or an away agent switch", () => {
    const state = new PanelFocusState();
    expect(state.get(1)).toBe(false);
    state.recordInteraction(1, true);
    state.recordInteraction(2, false);
    expect(state.shouldPreserveAgentOpen(1, true)).toBe(true);
    expect(state.shouldPreserveAgentOpen(1, false)).toBe(false);
    state.agentSwitchedPanel(1, true);
    expect(state.get(1)).toBe(true);
    state.agentSwitchedPanel(1, false);
    expect(state.get(1)).toBe(false);
    state.recordInteraction(2, true);
    state.delete(1);
    expect(state.get(1)).toBe(false);
    expect(state.get(2)).toBe(true);
  });
});

// FILE: appTabOpenedRouting.ts
// Purpose: Route App-tab selection without changing OS focus.

import type { DesktopAppTabOpened } from "@penkra/contracts";

import type { PanelFocusState } from "./panelFocus";
import type { ThreadHomeWindow } from "./threadHomeWindow";

export function announceAppTabOpened(input: {
  descriptor: DesktopAppTabOpened;
  windows: readonly { id: number; focused: boolean }[];
  home: ThreadHomeWindow;
  panelFocus: PanelFocusState;
}): {
  targetWindowId: number | null;
  deliveries: readonly { windowId: number; selection: "activate" | "preserve" }[];
} {
  const { descriptor, windows, home, panelFocus } = input;
  const targetWindowId = home.presentingWindow(
    descriptor.threadId,
    descriptor.deckId,
    windows.map((window) => window.id),
  );
  const target = windows.find((window) => window.id === targetWindowId);
  const agentOpen = descriptor.initiator === "agent";
  const preserveFocusedPanel =
    agentOpen &&
    target !== undefined &&
    panelFocus.shouldPreserveAgentOpen(target.id, target.focused);
  if (agentOpen && target && descriptor.selection === "activate" && !preserveFocusedPanel) {
    panelFocus.agentSwitchedPanel(target.id, target.focused);
  }
  if (!target && descriptor.selection === "activate") home.defer(descriptor.deckId, descriptor.id);
  return {
    targetWindowId,
    deliveries: windows.map((window) => ({
      windowId: window.id,
      selection:
        window.id === targetWindowId && !preserveFocusedPanel ? descriptor.selection : "preserve",
    })),
  };
}

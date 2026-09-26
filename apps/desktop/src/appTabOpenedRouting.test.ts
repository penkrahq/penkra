import { describe, expect, it } from "vitest";
import type { DesktopAppTabOpened } from "@penkra/contracts";

import { announceAppTabOpened } from "./appTabOpenedRouting";
import { PanelFocusState } from "./panelFocus";
import { ThreadHomeWindow } from "./threadHomeWindow";

const descriptor = (initiator: "agent" | "user"): DesktopAppTabOpened => ({
  id: "tab-a",
  rendererId: 100,
  appId: "com.penkra.browser",
  slug: "browser",
  name: "Browser",
  iconDataUrl: null,
  spaceId: "space-a",
  deckId: "deck-a",
  threadId: "thread-a",
  route: "/",
  status: "ready",
  selection: "activate",
  initiator,
});

describe("announceAppTabOpened", () => {
  it.each([
    { initiator: "agent" as const, focused: true, panelFocused: true, expected: "preserve" },
    { initiator: "agent" as const, focused: true, panelFocused: false, expected: "activate" },
    { initiator: "agent" as const, focused: false, panelFocused: true, expected: "activate" },
    { initiator: "user" as const, focused: true, panelFocused: true, expected: "activate" },
  ])(
    "routes $initiator with OS focus=$focused and panel focus=$panelFocused",
    ({ initiator, focused, panelFocused, expected }) => {
      const home = new ThreadHomeWindow();
      const panelFocus = new PanelFocusState();
      home.view(1, "thread-a", "deck-a", true);
      home.view(2, "thread-b", "deck-b", true);
      panelFocus.recordInteraction(1, panelFocused);
      const result = announceAppTabOpened({
        descriptor: descriptor(initiator),
        windows: [
          { id: 1, focused },
          { id: 2, focused: !focused },
        ],
        home,
        panelFocus,
      });
      expect(result.targetWindowId).toBe(1);
      expect(result.deliveries).toEqual([
        { windowId: 1, selection: expected },
        { windowId: 2, selection: "preserve" },
      ]);
    },
  );

  it("defers activation when no window shows the Deck", () => {
    const home = new ThreadHomeWindow();
    const result = announceAppTabOpened({
      descriptor: descriptor("agent"),
      windows: [{ id: 2, focused: true }],
      home,
      panelFocus: new PanelFocusState(),
    });
    expect(result.deliveries).toEqual([{ windowId: 2, selection: "preserve" }]);
    expect(home.consume("deck-a", ["tab-a"])).toBe("tab-a");
  });
});

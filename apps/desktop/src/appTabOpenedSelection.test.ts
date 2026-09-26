// FILE: appTabOpenedSelection.test.ts
// Purpose: Proves an agent Opened tab never activates in a window other than the one that started the turn.

import { describe, expect, it } from "vitest";
import type { DesktopAppTabOpened } from "@penkra/contracts";

import {
  flushQueuedAppTabs,
  queueAppTabOpened,
  resolveAppTabOpenedSelection,
  resolveAppTabOpenedTargetWindowId,
} from "./appTabOpenedSelection";

describe("resolveAppTabOpenedTargetWindowId", () => {
  it("keeps the agent's exact window when it is still ready", () => {
    expect(
      resolveAppTabOpenedTargetWindowId({ readyWindowIds: [10, 20, 30], agentSurfaceId: 20 }),
    ).toBe(20);
  });

  it("returns null instead of falling back when the agent's window is gone", () => {
    expect(
      resolveAppTabOpenedTargetWindowId({ readyWindowIds: [10, 30], agentSurfaceId: 20 }),
    ).toBeNull();
    expect(
      resolveAppTabOpenedTargetWindowId({ readyWindowIds: [], agentSurfaceId: 20 }),
    ).toBeNull();
  });

  it("keeps the first-ready-window default for non-agent opens", () => {
    expect(
      resolveAppTabOpenedTargetWindowId({ readyWindowIds: [10, 20], agentSurfaceId: null }),
    ).toBe(10);
    expect(
      resolveAppTabOpenedTargetWindowId({ readyWindowIds: [], agentSurfaceId: null }),
    ).toBeNull();
  });
});

describe("queued App tab opens", () => {
  const descriptor: DesktopAppTabOpened = {
    id: "tab-1",
    rendererId: 100,
    appId: "com.penkra.explorer",
    slug: "explorer",
    name: "Explorer",
    iconDataUrl: null,
    spaceId: "space-1",
    deckId: "deck-1",
    threadId: "thread-1",
    route: "/",
    status: "ready",
    selection: "activate",
    initiator: "user",
  };

  it("flushes an agent open as preserve after its sole origin window has closed", () => {
    const pending = new Map<string, DesktopAppTabOpened>();
    queueAppTabOpened(pending, descriptor, 10);
    const deliveredToNewWindow: DesktopAppTabOpened[] = [];
    flushQueuedAppTabs(pending, (opened) => deliveredToNewWindow.push(opened));
    expect(deliveredToNewWindow).toHaveLength(1);
    expect(deliveredToNewWindow[0]).toMatchObject({ id: "tab-1", selection: "preserve" });
    expect(pending.size).toBe(0);
    expect(descriptor.selection).toBe("activate");
  });

  it("keeps the normal activate selection for a queued non-agent open", () => {
    const pending = new Map<string, DesktopAppTabOpened>();
    queueAppTabOpened(pending, descriptor, null);
    expect([...pending.values()][0]?.selection).toBe("activate");
  });
});

describe("resolveAppTabOpenedSelection", () => {
  it("activates only the target window and preserves every other one", () => {
    expect(
      resolveAppTabOpenedSelection({
        windowId: 20,
        targetWindowId: 20,
        descriptorSelection: "activate",
        preserveFocusedPanel: false,
      }),
    ).toBe("activate");
    expect(
      resolveAppTabOpenedSelection({
        windowId: 10,
        targetWindowId: 20,
        descriptorSelection: "activate",
        preserveFocusedPanel: false,
      }),
    ).toBe("preserve");
  });

  it("opens in the background everywhere when there is no target window", () => {
    for (const windowId of [10, 30]) {
      expect(
        resolveAppTabOpenedSelection({
          windowId,
          targetWindowId: null,
          descriptorSelection: "activate",
          preserveFocusedPanel: false,
        }),
      ).toBe("preserve");
    }
  });

  it("never activates when the focused panel must be preserved", () => {
    expect(
      resolveAppTabOpenedSelection({
        windowId: 20,
        targetWindowId: 20,
        descriptorSelection: "activate",
        preserveFocusedPanel: true,
      }),
    ).toBe("preserve");
  });
});

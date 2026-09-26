// FILE: appTabOpenedSelection.ts
// Purpose: Decides which shell window an opened App tab may activate in, without falling back to an unrelated window.
// Layer: Desktop main-process helper

import type { DesktopAppTabOpened } from "@penkra/contracts";

export type AppTabOpenedSelection = DesktopAppTabOpened["selection"];

/**
 * Resolves the shell WebContents id that should activate an opened App tab.
 *
 * A non-agent open (`agentSurfaceId === null`) keeps the historical behavior of
 * activating in the first ready window. An agent-driven open must only activate
 * in the window that originated the turn; when that window is gone the target
 * is `null` so the tab opens in the background everywhere instead of activating
 * in an unrelated window.
 */
export function resolveAppTabOpenedTargetWindowId(input: {
  readonly readyWindowIds: readonly number[];
  readonly agentSurfaceId: number | null;
}): number | null {
  if (input.agentSurfaceId === null) return input.readyWindowIds[0] ?? null;
  return input.readyWindowIds.includes(input.agentSurfaceId) ? input.agentSurfaceId : null;
}

/** The per-window selection sent to each ready window for one opened App tab. */
export function resolveAppTabOpenedSelection(input: {
  readonly windowId: number;
  readonly targetWindowId: number | null;
  readonly descriptorSelection: AppTabOpenedSelection;
  readonly preserveFocusedPanel: boolean;
}): AppTabOpenedSelection {
  return input.windowId === input.targetWindowId && !input.preserveFocusedPanel
    ? input.descriptorSelection
    : "preserve";
}

/** A queued agent open has no live origin window to activate when it is flushed. */
export function queueAppTabOpened(
  pending: Map<string, DesktopAppTabOpened>,
  descriptor: DesktopAppTabOpened,
  agentSurfaceId: number | null,
): void {
  pending.set(
    descriptor.id,
    agentSurfaceId === null ? descriptor : { ...descriptor, selection: "preserve" },
  );
}

export function flushQueuedAppTabs(
  pending: Map<string, DesktopAppTabOpened>,
  deliver: (descriptor: DesktopAppTabOpened) => void,
): void {
  for (const descriptor of pending.values()) deliver(descriptor);
  pending.clear();
}

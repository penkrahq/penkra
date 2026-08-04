// FILE: hostedBrowserViewport.ts
// Purpose: Keeps hosted browser page geometry in the owning App view's coordinate space.
// Layer: Desktop App/browser native-view composition

import type { BrowserPanelBounds } from "@penkra/contracts";

export function normalizeHostedBrowserViewportBounds(
  localBounds: BrowserPanelBounds,
): BrowserPanelBounds {
  return {
    x: Math.round(localBounds.x),
    y: Math.round(localBounds.y),
    width: Math.max(0, Math.round(localBounds.width)),
    height: Math.max(0, Math.round(localBounds.height)),
  };
}

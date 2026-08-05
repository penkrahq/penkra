// FILE: rightDockPaneMeta.tsx
// Purpose: App-tab label and icon presentation for the right panel.
// Layer: Chat right-dock UI primitives
// Exports: App-tab label and icon resolvers.

import type { ReactNode } from "react";

import { AppsIcon } from "~/lib/icons";
import type { RightDockPane } from "~/rightDockStore.logic";
import { SurfaceChipIcon } from "./chatHeaderControls";

export function resolveRightDockPaneLabel(pane: RightDockPane): string {
  return pane.appName;
}

export function resolveRightDockPaneIcon(pane: RightDockPane): ReactNode {
  if (pane.appIconDataUrl) {
    return (
      <img
        alt=""
        className="size-3.5 shrink-0 object-contain"
        draggable={false}
        src={pane.appIconDataUrl}
      />
    );
  }
  return <SurfaceChipIcon icon={AppsIcon} />;
}

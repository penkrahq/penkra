import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import type { RightDockPane } from "~/rightDockStore.logic";
import { resolveRightDockPaneIcon, resolveRightDockPaneLabel } from "./rightDockPaneMeta";

const pane: RightDockPane = {
  id: "app-tab",
  kind: "app",
  appId: "com.penkra.explorer",
  appSpaceId: "space-1",
  appSlug: "explorer",
  appName: "Explorer",
  appIconDataUrl: "data:image/svg+xml,app-icon",
  appRoute: "/",
  appStatus: "ready",
};

describe("App tab metadata", () => {
  it("uses the App name and packaged artwork", () => {
    expect(resolveRightDockPaneLabel(pane)).toBe("Explorer");
    const icon = resolveRightDockPaneIcon(pane);
    expect(isValidElement(icon)).toBe(true);
    if (!isValidElement<{ src?: string }>(icon)) return;
    expect(icon.type).toBe("img");
    expect(icon.props.src).toBe(pane.appIconDataUrl);
  });
});

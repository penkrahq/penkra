import { describe, expect, it } from "vitest";

import { isValidElement } from "react";

import type { RightDockPane } from "~/rightDockStore.logic";
import { getRightDockPaneMeta, resolveRightDockPaneIcon } from "./rightDockPaneMeta";

describe("getRightDockPaneMeta", () => {
  it("labels App panes", () => {
    expect(getRightDockPaneMeta("app").label).toBe("App");
  });

  it("uses packaged artwork for an App pane tab", () => {
    const iconDataUrl = "data:image/svg+xml,app-icon";
    const pane = {
      id: "app-tab",
      kind: "app",
      appIconDataUrl: iconDataUrl,
    } as RightDockPane;

    const icon = resolveRightDockPaneIcon(pane);

    expect(isValidElement(icon)).toBe(true);
    if (!isValidElement<{ src?: string }>(icon)) return;
    expect(icon.type).toBe("img");
    expect(icon.props.src).toBe(iconDataUrl);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AppDockPane,
  hasRunningNativeViewExitTransition,
  nativeAppViewBoundsSignature,
  shouldShowNativeAppView,
} from "./AppDockPane";

describe("AppDockPane", () => {
  it("keeps the native renderer hidden until it is ready", () => {
    expect(shouldShowNativeAppView(true, "loading")).toBe(false);
    expect(shouldShowNativeAppView(true, "crashed")).toBe(false);
    expect(shouldShowNativeAppView(false, "ready")).toBe(false);
    expect(shouldShowNativeAppView(true, "ready")).toBe(true);
  });

  it("retains the native renderer only while the dock has a running exit transition", () => {
    expect(hasRunningNativeViewExitTransition([])).toBe(false);
    expect(hasRunningNativeViewExitTransition([{ playState: "finished" }])).toBe(false);
    expect(
      hasRunningNativeViewExitTransition([{ playState: "finished" }, { playState: "running" }]),
    ).toBe(true);
  });

  it("deduplicates native geometry using position and size", () => {
    expect(nativeAppViewBoundsSignature({ x: 12, y: 24, width: 480, height: 720 })).toBe(
      "12:24:480:720",
    );
    expect(nativeAppViewBoundsSignature({ x: 13, y: 24, width: 480, height: 720 })).not.toBe(
      nativeAppViewBoundsSignature({ x: 12, y: 24, width: 480, height: 720 }),
    );
  });

  it("renders only the selected App icon while loading", () => {
    const html = renderToStaticMarkup(
      <AppDockPane
        appName="Figma"
        iconDataUrl="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
        rendererId={101}
        status="loading"
        tabId="tab-1"
        visible={true}
      />,
    );

    expect(html).toContain('aria-label="Loading Figma"');
    expect(html).toContain("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    expect(html).not.toContain("Loading App");
  });
});

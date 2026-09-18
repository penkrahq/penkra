import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppDockPane } from "./AppDockPane";

describe("AppDockPane", () => {
  it("renders loading chrome without an iframe or webview", () => {
    const html = renderToStaticMarkup(
      <AppDockPane
        deckId="deck-1"
        threadId="thread-1"
        appName="Figma"
        iconDataUrl="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
        rendererId={12}
        status="loading"
        tabId="tab-1"
        visible
        animateEntrance={false}
        animationStartedAtEpochMs={null}
      />,
    );
    expect(html).toContain('aria-label="Loading Figma"');
    expect(html).toContain('data-app-tab-id="tab-1"');
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("webview");
  });

  it("does not publish an inactive tab as the visible native surface", () => {
    const html = renderToStaticMarkup(
      <AppDockPane
        deckId="deck-1"
        threadId="thread-1"
        appName="Canvas"
        rendererId={17}
        status="ready"
        tabId="canvas-tab"
        visible={false}
        animateEntrance={false}
        animationStartedAtEpochMs={null}
      />,
    );
    expect(html).not.toContain("data-app-tab-id");
  });
});

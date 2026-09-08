import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppDockPane } from "./AppDockPane";

describe("AppDockPane", () => {
  it("renders one sandboxed App frame and the selected icon while loading", () => {
    const html = renderToStaticMarkup(
      <AppDockPane
        appName="Figma"
        iconDataUrl="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
        rendererId={-1}
        documentUrl="penkra-app://a-test/app.html"
        status="loading"
        tabId="tab-1"
        visible={true}
      />,
    );

    expect(html).toContain('aria-label="Loading Figma"');
    expect(html).toContain('sandbox="allow-forms allow-modals allow-same-origin allow-scripts"');
    expect(html).toContain('data-app-tab-id="tab-1"');
    expect(html).toContain('name="penkra-app-tab:tab-1"');
    expect(html).toContain("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    expect(html).not.toContain("Loading App");
  });

  it("keeps a retained non-visible App frame rendered for tab-scoped semantic access", () => {
    const html = renderToStaticMarkup(
      <AppDockPane
        appName="Canvas"
        rendererId={7}
        documentUrl="penkra-app://canvas/app.html"
        status="ready"
        tabId="canvas-tab"
        visible={false}
      />,
    );

    expect(html).toContain('data-app-tab-id="canvas-tab"');
    expect(html).not.toContain(' hidden=""');
  });
});

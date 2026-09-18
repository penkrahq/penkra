import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RightDockPane } from "~/rightDockStore.logic";
import { RightDock } from "./RightDock";

function pane(id: string, name: string): RightDockPane {
  return {
    id,
    kind: "app",
    appId: `com.example.${id}`,
    appSpaceId: "space-1",
    appSlug: id,
    appName: name,
    appRoute: "/",
    appStatus: "ready",
  };
}

describe("RightDock App surface", () => {
  it("renders only the selected pane while main retains inactive App views", () => {
    const canvas = pane("canvas-tab", "Canvas");
    const browser = pane("browser-tab", "Browser");
    const html = renderToStaticMarkup(
      <RightDock
        state={{ open: true, panes: [canvas], activePaneId: canvas.id, width: null }}
        minWidth={320}
        defaultWidth="50vw"
        shouldAcceptWidth={() => true}
        onSelectPane={vi.fn()}
        onClosePane={vi.fn()}
        onOpenChange={vi.fn()}
        renderPane={(selectedPane, { isVisible, animateEntrance }) => (
          <div
            data-rendered-app={selectedPane.id}
            data-visible={String(isVisible)}
            data-animate-entrance={String(animateEntrance)}
          />
        )}
      />,
    );

    expect(html).toContain('data-rendered-app="canvas-tab" data-visible="true"');
    expect(html).toContain('data-animate-entrance="false"');
    expect(html).not.toContain('data-rendered-app="browser-tab"');
    expect(html).not.toContain("pointer-events-none invisible");
    expect(html).not.toContain(' hidden=""');
  });
});

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

describe("RightDock retained App surfaces", () => {
  it("keeps inactive and other-Thread App surfaces mounted while showing only the active pane", () => {
    const canvas = pane("canvas-tab", "Canvas");
    const browser = pane("browser-tab", "Browser");
    const html = renderToStaticMarkup(
      <RightDock
        state={{ open: true, panes: [canvas], activePaneId: canvas.id, width: null }}
        retainedPanes={[canvas, browser]}
        minWidth={320}
        defaultWidth="50vw"
        shouldAcceptWidth={() => true}
        onSelectPane={vi.fn()}
        onClosePane={vi.fn()}
        onOpenChange={vi.fn()}
        renderPane={(retainedPane, { isVisible }) => (
          <div data-retained-app={retainedPane.id} data-visible={String(isVisible)} />
        )}
      />,
    );

    expect(html).toContain('data-retained-app="canvas-tab" data-visible="true"');
    expect(html).toContain('data-retained-app="browser-tab" data-visible="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events-none invisible");
    expect(html).not.toContain(' hidden=""');
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RightDockPane } from "~/rightDockStore.logic";
import { RightDock } from "./RightDock";

afterEach(() => vi.restoreAllMocks());

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

it("ends opening presentation only on the dock's own width transition and clears it on close", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    transitionProperty: "width, visibility",
    transitionDuration: "0.2s",
  } as CSSStyleDeclaration);
  const canvas = pane("canvas-tab", "Canvas");
  const renderPane = vi.fn((_pane, { animateEntrance }: { animateEntrance: boolean }) => (
    <div data-entrance={String(animateEntrance)} />
  ));
  const render = (open: boolean) =>
    act(() =>
      root.render(
        <RightDock
          state={{ open, panes: [canvas], activePaneId: canvas.id, width: null }}
          minWidth={320}
          defaultWidth="50vw"
          shouldAcceptWidth={() => true}
          onSelectPane={vi.fn()}
          onClosePane={vi.fn()}
          onOpenChange={vi.fn()}
          renderPane={renderPane}
        />,
      ),
    );
  const transition = (target: Element, propertyName: string, type = "transitionend") =>
    act(() => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: propertyName });
      target.dispatchEvent(event);
    });
  try {
    render(false);
    render(true);
    const dock = container.querySelector('[data-slot="sidebar-container"]')!;
    const content = container.querySelector("[data-entrance]")!;
    expect(content.getAttribute("data-entrance")).toBe("true");
    transition(content, "width");
    transition(dock, "visibility");
    expect(content.getAttribute("data-entrance")).toBe("true");
    transition(dock, "width");
    expect(content.getAttribute("data-entrance")).toBe("false");
    render(false);
    render(true);
    const reopenedDock = container.querySelector('[data-slot="sidebar-container"]')!;
    expect(container.querySelector("[data-entrance]")?.getAttribute("data-entrance")).toBe("true");
    transition(reopenedDock, "width", "transitioncancel");
    expect(container.querySelector("[data-entrance]")?.getAttribute("data-entrance")).toBe("false");
    transition(reopenedDock, "width", "transitionrun");
    expect(container.querySelector("[data-entrance]")?.getAttribute("data-entrance")).toBe("false");
    render(false);
    expect(container.querySelector("[data-entrance]")).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it.each([
  ["reduced motion", "none", "0s", 0],
  ["suppressed motion", "width", "0s", 0],
  ["unchanged width", "width", "0.2s", 320],
])(
  "leaves entrance presentation inactive with %s",
  (_name, transitionProperty, transitionDuration, fromWidth) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      transitionProperty,
      transitionDuration,
    } as CSSStyleDeclaration);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, 0, this.dataset.slot === "sidebar-container" ? fromWidth : 0, 0);
      },
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const canvas = pane("canvas-tab", "Canvas");
    const render = (open: boolean) =>
      act(() =>
        root.render(
          <RightDock
            state={{ open, panes: [canvas], activePaneId: canvas.id, width: null }}
            minWidth={320}
            defaultWidth="50vw"
            shouldAcceptWidth={() => true}
            onSelectPane={vi.fn()}
            onClosePane={vi.fn()}
            onOpenChange={vi.fn()}
            renderPane={(_pane, { animateEntrance }) => (
              <div data-entrance={String(animateEntrance)} />
            )}
          />,
        ),
      );
    try {
      render(false);
      render(true);
      expect(container.querySelector("[data-entrance]")?.getAttribute("data-entrance")).toBe(
        "false",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);

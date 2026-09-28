import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { RightDockDeckState } from "~/rightDockStore.logic";
import { RightDock } from "./RightDock";

const pane = {
  id: "apps-tab",
  kind: "app" as const,
  appId: "com.penkra.apps",
  appSpaceId: "space-1",
  appSlug: "apps",
  appName: "Apps",
  appRoute: "/",
  appStatus: "ready" as const,
};

afterEach(() => {
  document.body.innerHTML = "";
});

function dock(
  state: RightDockDeckState,
  motionKey: string,
  options: { shellWidth?: number; contentMinWidth?: number } = {},
) {
  return (
    <div className="flex h-[600px]" style={{ width: options.shellWidth ?? 1_200 }}>
      <div className="min-w-0 flex-1" />
      <RightDock
        state={state}
        minWidth={320}
        {...(options.contentMinWidth === undefined
          ? {}
          : { contentMinWidth: options.contentMinWidth })}
        defaultWidth="50vw"
        shouldAcceptWidth={() => true}
        motionKey={motionKey}
        onSelectPane={vi.fn()}
        onClosePane={vi.fn()}
        onOpenChange={vi.fn()}
        renderPane={() => <div />}
      />
    </div>
  );
}

describe("RightDock Thread width", () => {
  it("keeps the live drag width until pointer release with and without an App tab", async () => {
    await page.viewport(1280, 800);
    for (const panes of [[], [pane]]) {
      const onResize = vi.fn();
      const state: RightDockDeckState = {
        open: true,
        panes,
        activePaneId: panes[0]?.id ?? null,
        width: 560,
      };
      const view = await render(
        <div className="flex h-[600px]" style={{ width: 1_200 }}>
          <div className="min-w-0 flex-1" />
          <RightDock
            state={state}
            minWidth={320}
            defaultWidth="50vw"
            shouldAcceptWidth={() => true}
            motionKey="drag-test"
            onSelectPane={vi.fn()}
            onClosePane={vi.fn()}
            onOpenChange={vi.fn()}
            onResize={onResize}
            renderPane={() => <div data-app-tab-id="test-app" />}
          />
        </div>,
      );
      const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")!;
      const rail = document.querySelector<HTMLButtonElement>("[data-slot='sidebar-rail']")!;
      expect(wrapper.querySelector("[data-app-tab-id]") !== null).toBe(panes.length > 0);
      let capturedPointerId: number | null = null;
      rail.setPointerCapture = (id) => {
        capturedPointerId = id;
      };
      rail.hasPointerCapture = (id) => capturedPointerId === id;
      rail.releasePointerCapture = () => {
        capturedPointerId = null;
      };
      const startX = rail.getBoundingClientRect().left + 4;
      const pointerId = 17;
      rail.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: startX, pointerId }),
      );
      rail.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: startX - 100,
          pointerId,
        }),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("660px");
      expect(Math.round(wrapper.getBoundingClientRect().width)).toBe(660);
      rail.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          clientX: startX - 100,
          pointerId,
        }),
      );
      expect(onResize).toHaveBeenCalledWith(660);
      await view.unmount();
    }
  });

  it("reserves App-tab dividers and hides the lines beside the active tab", async () => {
    await page.viewport(1280, 800);
    const panes = [
      pane,
      { ...pane, id: "canvas-tab", appName: "Canvas" },
      { ...pane, id: "browser-tab", appName: "Browser" },
    ];
    const view = await render(
      dock({ open: true, panes, activePaneId: "canvas-tab", width: 560 }, "thread-a"),
    );

    const dividers = () => [
      ...document.querySelectorAll<HTMLElement>("[data-slot='right-dock-tab-divider']"),
    ];
    expect(dividers()).toHaveLength(2);
    expect(dividers().every((divider) => divider.classList.contains("invisible"))).toBe(true);
    expect(dividers().every((divider) => divider.getBoundingClientRect().width === 1)).toBe(true);

    await view.rerender(dock({ open: true, panes, activePaneId: pane.id, width: 560 }, "thread-a"));
    expect(dividers()).toHaveLength(2);
    expect(dividers()[0]?.classList.contains("invisible")).toBe(true);
    expect(dividers()[1]?.classList.contains("invisible")).toBe(false);
  });

  it("reapplies each Thread width and gives a new Thread the standard default", async () => {
    await page.viewport(1280, 800);
    const view = await render(
      dock({ open: true, panes: [pane], activePaneId: pane.id, width: 560 }, "thread-a"),
    );
    const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
    const shell = wrapper?.parentElement;
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("560px");
    expect(shell?.style.getPropertyValue("--right-dock-overlay-inset")).toBe("560px");

    await view.rerender(
      dock({ open: true, panes: [pane], activePaneId: pane.id, width: 740 }, "thread-b"),
    );
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("740px");
    expect(shell?.style.getPropertyValue("--right-dock-overlay-inset")).toBe("740px");

    await view.rerender(
      dock({ open: true, panes: [pane], activePaneId: pane.id, width: null }, "thread-new"),
    );
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("600px");
    expect(shell?.style.getPropertyValue("--right-dock-overlay-inset")).toBe("600px");

    await view.rerender(
      dock({ open: false, panes: [pane], activePaneId: pane.id, width: null }, "thread-new"),
    );
    expect(shell?.style.getPropertyValue("--right-dock-overlay-inset")).toBe("0px");
  });

  it("reconciles the rendered dock width when its parent shell shrinks", async () => {
    await page.viewport(1280, 800);
    const state: RightDockDeckState = {
      open: true,
      panes: [pane],
      activePaneId: pane.id,
      width: 740,
    };
    const view = await render(dock(state, "thread-a", { shellWidth: 1_200, contentMinWidth: 400 }));
    const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("740px");

    await view.rerender(dock(state, "thread-a", { shellWidth: 900, contentMinWidth: 400 }));
    await vi.waitFor(() =>
      expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("500px"),
    );
  });
});

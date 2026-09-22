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

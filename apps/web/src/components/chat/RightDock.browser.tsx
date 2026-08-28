import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { RightDockThreadState } from "~/rightDockStore.logic";
import { RightDock } from "./RightDock";

const pane = {
  id: "apps-tab",
  kind: "app" as const,
  appId: "com.penkra.apps",
  appSlug: "apps",
  appName: "Apps",
  appRoute: "/",
  appStatus: "ready" as const,
};

afterEach(() => {
  document.body.innerHTML = "";
});

function dock(
  state: RightDockThreadState,
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
  it("reapplies each Thread width and gives a new Thread the standard default", async () => {
    await page.viewport(1280, 800);
    const view = await render(
      dock({ open: true, panes: [pane], activePaneId: pane.id, width: 560 }, "thread-a"),
    );
    const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("560px");

    await view.rerender(
      dock({ open: true, panes: [pane], activePaneId: pane.id, width: 740 }, "thread-b"),
    );
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("740px");

    await view.rerender(
      dock({ open: true, panes: [pane], activePaneId: pane.id, width: null }, "thread-new"),
    );
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("600px");
  });

  it("reconciles the rendered dock width when its parent shell shrinks", async () => {
    await page.viewport(1280, 800);
    const state: RightDockThreadState = {
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

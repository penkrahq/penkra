import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { AppDockPane } from "./AppDockPane";

const originalDesktopBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");

afterEach(() => {
  document.body.innerHTML = "";
  if (originalDesktopBridge) {
    Object.defineProperty(window, "desktopBridge", originalDesktopBridge);
  } else {
    Reflect.deleteProperty(window, "desktopBridge");
  }
});

describe("AppDockPane native exit motion", () => {
  it("reattaches a replacement renderer and scopes retired cleanup to the old renderer", async () => {
    const attach = vi.fn(async () => undefined);
    const setVisible = vi.fn(async () => undefined);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        appTabs: {
          attach,
          setBounds: vi.fn(async () => undefined),
          setVisible,
        },
      },
    });

    function Harness() {
      const [rendererId, setRendererId] = useState(101);
      return (
        <>
          <button onClick={() => setRendererId(202)} type="button">
            Replace renderer
          </button>
          <AppDockPane
            appName="Canvas"
            rendererId={rendererId}
            status="ready"
            tabId="stable-tab"
            visible={true}
          />
        </>
      );
    }

    await render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await page.getByRole("button", { name: "Replace renderer" }).click();
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(attach).toHaveBeenCalledWith({ tabId: "stable-tab", rendererId: 101 });
    expect(attach).toHaveBeenCalledWith({ tabId: "stable-tab", rendererId: 202 });
    expect(setVisible).toHaveBeenCalledWith({
      tabId: "stable-tab",
      rendererId: 101,
      visible: false,
    });
    expect(setVisible).toHaveBeenCalledWith({
      tabId: "stable-tab",
      rendererId: 202,
      visible: true,
    });
  });

  it("keeps the native App visible until its dock transition finishes", async () => {
    const setVisible = vi.fn(async () => undefined);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        appTabs: {
          attach: vi.fn(async () => undefined),
          setBounds: vi.fn(async () => undefined),
          setVisible,
        },
      },
    });

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(false)} type="button">
            Close dock
          </button>
          <div
            className={`h-40 w-80 transition-transform duration-300 ease-linear ${
              open ? "translate-x-0" : "translate-x-full"
            }`}
            data-slot="sidebar-container"
          >
            <AppDockPane
              appName="Apps"
              rendererId={101}
              status="ready"
              tabId="tab-1"
              visible={open}
            />
          </div>
        </>
      );
    }

    await render(<Harness />);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    setVisible.mockClear();

    await page.getByRole("button", { name: "Close dock" }).click();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(setVisible).not.toHaveBeenCalledWith({
      tabId: "tab-1",
      rendererId: 101,
      visible: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(setVisible).toHaveBeenCalledWith({
      tabId: "tab-1",
      rendererId: 101,
      visible: false,
    });
  });

  it("tracks a dock position transition even when its size does not change", async () => {
    const setBounds = vi.fn(
      async (_input: {
        tabId: string;
        bounds: { x: number; y: number; width: number; height: number };
      }) => undefined,
    );
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: {
        appTabs: {
          attach: vi.fn(async () => undefined),
          setBounds,
          setVisible: vi.fn(async () => undefined),
        },
      },
    });

    function Harness() {
      const [shifted, setShifted] = useState(false);
      return (
        <>
          <button onClick={() => setShifted(true)} type="button">
            Shift dock
          </button>
          <div
            className="h-40 w-80 transition-transform duration-300 ease-linear"
            data-slot="sidebar-container"
            style={{ transform: shifted ? "translateX(120px)" : "translateX(0)" }}
          >
            <AppDockPane
              appName="Apps"
              rendererId={101}
              status="ready"
              tabId="tab-1"
              visible={true}
            />
          </div>
        </>
      );
    }

    await render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const initialX = setBounds.mock.calls.at(-1)?.[0].bounds.x;
    expect(initialX).toBeTypeOf("number");

    await page.getByRole("button", { name: "Shift dock" }).click();
    await new Promise((resolve) => setTimeout(resolve, 375));
    const finalX = setBounds.mock.calls.at(-1)?.[0].bounds.x;

    expect(finalX).toBeGreaterThan((initialX ?? 0) + 115);
  });
});

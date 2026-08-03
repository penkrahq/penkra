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
            <AppDockPane appName="Apps" status="ready" tabId="tab-1" visible={open} />
          </div>
        </>
      );
    }

    await render(<Harness />);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    setVisible.mockClear();

    await page.getByRole("button", { name: "Close dock" }).click();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(setVisible).not.toHaveBeenCalledWith({ tabId: "tab-1", visible: false });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(setVisible).toHaveBeenCalledWith({ tabId: "tab-1", visible: false });
  });
});

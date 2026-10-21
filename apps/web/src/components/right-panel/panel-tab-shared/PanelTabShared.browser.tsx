import "../../../index.css";
import { useState } from "react";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { PanelTabShared } from "./PanelTabShared";

function Tabs() {
  const [tabs, setTabs] = useState(["First", "Second", "Third"]);
  return (
    <div className="flex">
      {tabs.map((tab) => (
        <PanelTabShared
          key={tab}
          className="w-40"
          onClose={() => setTabs(tabs.filter((entry) => entry !== tab))}
        >
          {tab}
        </PanelTabShared>
      ))}
      <button>Outside tabs</button>
    </div>
  );
}

it("shows the close control on the tab sliding under a stationary pointer", async () => {
  const screen = await render(<Tabs />);
  try {
    await page.getByRole("tab", { name: "First" }).hover();
    await page.getByRole("button", { name: "Close First" }).click();
    const nextClose = () => document.querySelector<HTMLElement>('[aria-label="Close Second"]')!;
    await expect.poll(() => getComputedStyle(nextClose()).opacity).toBe("1");
    await page.getByRole("button", { name: "Close Second" }).click();
    await expect
      .poll(
        () =>
          getComputedStyle(document.querySelector<HTMLElement>('[aria-label="Close Third"]')!)
            .opacity,
      )
      .toBe("1");
    await page.getByRole("button", { name: "Outside tabs" }).hover();
    await expect
      .poll(
        () =>
          getComputedStyle(document.querySelector<HTMLElement>('[aria-label="Close Third"]')!)
            .opacity,
      )
      .toBe("0");
  } finally {
    await screen.unmount();
  }
});

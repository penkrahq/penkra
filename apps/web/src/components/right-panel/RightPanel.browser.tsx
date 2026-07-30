import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppListRowShared } from "./app-list-row-shared/AppListRowShared";
import { AppBarShared } from "./app-bar-shared/AppBarShared";
import { PanelTabs } from "./panel-tabs/PanelTabs";

describe("Pencil right panel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps tabs and app rows as native controls", async () => {
    const onSelect = vi.fn();
    await render(
      <>
        <PanelTabs onSelect={onSelect} />
        <AppListRowShared>Browser</AppListRowShared>
      </>,
    );

    await page.getByRole("tab", { name: "Review" }).click();
    await page.getByRole("button", { name: "Browser" }).click();
    expect(onSelect).toHaveBeenCalledWith("review");
  });

  it("keeps app-bar navigation as separate native actions", async () => {
    const onBack = vi.fn();
    const onRefresh = vi.fn();
    await render(<AppBarShared onBack={onBack} onRefresh={onRefresh} />);

    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Refresh" }).click();

    expect(onBack).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppListRowShared } from "./app-list-row-shared/AppListRowShared";
import { PanelTabs } from "./panel-tabs/PanelTabs";
import { PermissionSheet } from "./permission-sheet/PermissionSheet";

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

  it("uses an actual switch for permission decisions", async () => {
    await render(<PermissionSheet />);
    const permission = page.getByRole("switch", { name: "Connect to the internet" });
    await expect.element(permission).toBeChecked();
    await permission.click();
    await expect.element(permission).not.toBeChecked();
  });
});

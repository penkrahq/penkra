import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { InputSearchApps } from "./input-search-apps/InputSearchApps";
import { PermissionSheetInstall } from "./permission-sheet-install/PermissionSheetInstall";
import { PanelAppsContent } from "../right-panel/panel-apps/PanelApps";

describe("Pencil apps structure", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a real search input and the shared Apps panel content", async () => {
    await render(
      <div>
        <InputSearchApps />
        <PanelAppsContent />
      </div>,
    );

    const search = page.getByRole("searchbox", { name: "Search apps" });
    await search.fill("figma");
    await expect.element(search).toHaveValue("figma");
    await expect.element(page.getByText("GitHub", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Linear", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Terminal", { exact: true })).not.toBeInTheDocument();
  });

  it("keeps install permissions interactive", async () => {
    const onInstall = vi.fn();
    await render(<PermissionSheetInstall onInstall={onInstall} />);

    await page.getByRole("switch", { name: "Read the conversation you're in" }).click();
    await page.getByRole("button", { name: "Install" }).click();
    expect(onInstall).toHaveBeenCalledOnce();
  });
});

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ModalAppsGallery } from "./modal-apps-gallery/ModalAppsGallery";
import { PermissionSheetInstall } from "./permission-sheet-install/PermissionSheetInstall";

describe("Pencil apps structure", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a real search input and an independent content scroll region", async () => {
    await render(<ModalAppsGallery className="h-[420px]" />);

    const search = page.getByRole("searchbox", { name: "Search apps" });
    const viewport = document.querySelector<HTMLElement>(
      "[data-pencil-region='apps-gallery-content'] [data-slot='scroll-area-viewport']",
    );
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);

    await search.fill("figma");
    await expect.element(search).toHaveValue("figma");
    await expect.element(page.getByText("Figma", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Excel", { exact: true })).not.toBeInTheDocument();

  });

  it("keeps install permissions interactive", async () => {
    const onInstall = vi.fn();
    await render(<PermissionSheetInstall onInstall={onInstall} />);

    await page.getByRole("switch", { name: "Read the conversation you're in" }).click();
    await page.getByRole("button", { name: "Install" }).click();
    expect(onInstall).toHaveBeenCalledOnce();
  });
});

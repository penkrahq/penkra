import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ModalSettings } from "./modal-settings/ModalSettings";
import { OpenWithRowShared } from "./open-with-row-shared/OpenWithRowShared";
import { ThemePanelShared } from "./theme-panel-shared/ThemePanelShared";

describe("Pencil settings structure", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps navigation interactive and content independently scrollable", async () => {
    const onPageChange = vi.fn();
    await render(<ModalSettings className="h-80" onPageChange={onPageChange} />);

    await page.getByRole("button", { name: "Appearance" }).click();
    expect(onPageChange).toHaveBeenCalledWith("appearance");

    const viewport = document.querySelector<HTMLElement>(
      "[data-pencil-region='settings-content'] [data-slot='scroll-area-viewport']",
    );
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
  });

  it("uses native interactive controls for expandable and theme settings", async () => {
    await render(
      <div>
        <OpenWithRowShared />
        <ThemePanelShared />
      </div>,
    );

    await page.getByRole("button", { name: /Open with/i }).click();
    await expect.element(page.getByRole("option", { name: /Finder/i })).toBeVisible();
    await page.getByRole("option", { name: /Finder/i }).click();
    await expect.element(page.getByRole("button", { name: /Finder/i })).toBeVisible();

    await page.getByRole("slider", { name: "Contrast" }).fill("62");
    await expect.element(page.getByText("62", { exact: true })).toBeVisible();
    const uiFont = page.getByRole("textbox", { name: "UI font" });
    await uiFont.fill("Inter");
    await expect.element(uiFont).toHaveValue("Inter");
  });
});

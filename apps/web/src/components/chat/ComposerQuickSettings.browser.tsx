import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerQuickSettings } from "./ComposerQuickSettings";

describe("ComposerQuickSettings", () => {
  it("shows its designed tooltip on hover", async () => {
    const screen = await render(<ComposerQuickSettings onSelect={vi.fn()} />);

    try {
      await page.getByRole("button", { name: "Change mode" }).hover();
      await expect.element(page.getByText("Change mode", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("opens the designed quick-settings rows and forwards a selection", async () => {
    const onSelect = vi.fn();
    const screen = await render(<ComposerQuickSettings onSelect={onSelect} />);

    try {
      await page.getByRole("button", { name: "Change mode" }).click();
      await expect.element(page.getByRole("menu", { name: "Quick settings" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Model" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Effort" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Speed" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "Advanced" })).toBeVisible();

      await page.getByRole("menuitem", { name: "Effort" }).click();
      expect(onSelect).toHaveBeenCalledTimes(1);
      await expect
        .element(page.getByRole("menu", { name: "Quick settings" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});

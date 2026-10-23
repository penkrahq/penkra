import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerSavedPrompts } from "./ComposerSavedPrompts";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

afterEach(() => vi.unstubAllGlobals());

it("keeps native App views visible while Saved opens and closes", async () => {
  const overlayActive = vi.fn();
  vi.stubGlobal("desktopBridge", { appTabs: { overlayActive } });
  await render(
    <ComposerSavedPrompts
      prompts={[]}
      shortcutLabel={null}
      onRestore={() => true}
      onDelete={() => {}}
    />,
  );
  await page.getByTestId("composer-saved-prompts").click();
  await expect.element(page.getByTestId("composer-saved-prompts-list")).toBeVisible();
  expect(overlayActive).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("composer-saved-prompts-list")).not.toBeInTheDocument();
  expect(overlayActive).not.toHaveBeenCalled();
});

it("preserves native overlay protection for ordinary popovers", async () => {
  const overlayActive = vi.fn();
  vi.stubGlobal("desktopBridge", { appTabs: { overlayActive } });
  await render(
    <Popover>
      <PopoverTrigger>Open ordinary popup</PopoverTrigger>
      <PopoverPopup>Ordinary popup</PopoverPopup>
    </Popover>,
  );
  await page.getByRole("button", { name: "Open ordinary popup" }).click();
  await expect.element(page.getByText("Ordinary popup", { exact: true })).toBeVisible();
  expect(overlayActive).toHaveBeenCalledWith(true);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => overlayActive.mock.lastCall).toEqual([false]);
});

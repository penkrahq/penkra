// FILE: chatHeaderControls.browser.tsx
// Purpose: Browser regressions for interactive versus static shared surface-tab chips.
// Layer: Chat header controls test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SurfaceTabChip } from "./chatHeaderControls";

describe("SurfaceTabChip selection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a static label when a single-pane host omits selection", async () => {
    await render(
      <SurfaceTabChip
        active
        icon={<span aria-hidden>PR</span>}
        label="PR #42"
        closeLabel="Close PR #42"
        onClose={vi.fn()}
      />,
    );

    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(page.getByRole("button", { name: "Close PR #42" })).toBeVisible();
    expect(document.body.textContent).toContain("PR #42");
    expect(document.querySelector("[aria-pressed]")).toBeNull();
  });

  it("keeps the selectable button for multi-pane hosts", async () => {
    const onSelect = vi.fn();
    await render(
      <SurfaceTabChip
        active
        icon={<span aria-hidden>PR</span>}
        label="PR #42"
        onSelect={onSelect}
      />,
    );

    const selectButton = document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    expect(selectButton).not.toBeNull();
    selectButton?.click();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("centers a custom close glyph in the tab icon slot", async () => {
    await render(
      <SurfaceTabChip
        active
        closeIcon={<span className="block size-3" data-testid="custom-close-glyph" />}
        closeLabel="Archive thread"
        icon={<span aria-hidden>AI</span>}
        label="Thread"
        onClose={vi.fn()}
      />,
    );

    const button = page.getByRole("button", { name: "Archive thread" }).element();
    const glyph = page.getByTestId("custom-close-glyph").element();
    const buttonRect = button.getBoundingClientRect();
    const glyphRect = glyph.getBoundingClientRect();
    expect(glyphRect.left + glyphRect.width / 2).toBeCloseTo(
      buttonRect.left + buttonRect.width / 2,
      1,
    );
    expect(glyphRect.top + glyphRect.height / 2).toBeCloseTo(
      buttonRect.top + buttonRect.height / 2,
      1,
    );
  });
});

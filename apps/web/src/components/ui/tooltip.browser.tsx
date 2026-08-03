import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Tooltip, TooltipPopup, TooltipProvider, TooltipShortcut, TooltipTrigger } from "./tooltip";

describe("shared tooltip chrome", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("matches the Pencil hover tooltip surface, typography, padding, and pointer", async () => {
    await render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Target</TooltipTrigger>
          <TooltipPopup>
            <span>Select model</span>
            <TooltipShortcut>⌃⇧M</TooltipShortcut>
          </TooltipPopup>
        </Tooltip>
      </TooltipProvider>,
    );

    const popup = document.querySelector<HTMLElement>("[data-slot='tooltip-popup']")!;
    const viewport = document.querySelector<HTMLElement>("[data-slot='tooltip-viewport']")!;
    const pointer = document.querySelector<HTMLElement>("[data-slot='tooltip-arrow']")!;
    const shortcut = document.querySelector<HTMLElement>("[data-pencil-node='qrW5C']")!;
    const popupStyle = getComputedStyle(popup);
    const viewportStyle = getComputedStyle(viewport);

    expect(popup.dataset.pencilComponent).toBe("Q5AL4");
    expect(getComputedStyle(popup).backgroundColor).toBe("rgb(0, 0, 0)");
    expect(popupStyle.borderRadius).toBe("8px");
    expect(popupStyle.fontSize).toBe("12px");
    expect(popupStyle.lineHeight).toBe("16px");
    expect(popupStyle.fontWeight).toBe("400");
    expect(viewportStyle.paddingTop).toBe("6px");
    expect(viewportStyle.paddingRight).toBe("10px");
    expect(viewportStyle.gap).toBe("8px");
    expect(pointer.getBoundingClientRect().width).toBe(8);
    expect(pointer.getBoundingClientRect().height).toBe(4);
    expect(getComputedStyle(shortcut).borderRadius).toBe("999px");
    expect(getComputedStyle(shortcut).fontSize).toBe("11px");
  });
});

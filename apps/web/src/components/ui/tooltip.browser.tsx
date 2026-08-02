import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

describe("shared tooltip chrome", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the same black surface for the body and pointer", async () => {
    await render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger>Target</TooltipTrigger>
          <TooltipPopup>Tooltip</TooltipPopup>
        </Tooltip>
      </TooltipProvider>,
    );

    const popup = document.querySelector<HTMLElement>("[data-slot='tooltip-popup']")!;
    const pointer = document.querySelector<HTMLElement>("[data-slot='tooltip-arrow'] > span")!;
    expect(getComputedStyle(popup).backgroundColor).toBe("rgb(0, 0, 0)");
    expect(getComputedStyle(pointer).backgroundColor).toBe("rgb(0, 0, 0)");
  });
});

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ButtonPrimary } from "./button-primary/ButtonPrimary";
import { InputShared } from "./input-shared/InputShared";
import { SwitchShared } from "./switch-shared/SwitchShared";

describe("Pencil foundations", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps shared inputs native, editable, and visibly focused", async () => {
    await render(
      <InputShared
        aria-label="API key"
        leadingIcon={<span data-testid="key-icon">K</span>}
        placeholder="Enter value..."
      />,
    );

    const input = page.getByRole("textbox", { name: "API key" });
    await input.fill("sk-local");
    await expect.element(input).toHaveValue("sk-local");

    const element = input.element() as HTMLInputElement;
    const control = element.closest<HTMLElement>("[data-slot='input-shared']");
    element.focus();
    expect(document.activeElement).toBe(element);
    await vi.waitFor(() => {
      expect(getComputedStyle(control!).borderColor).toBe("rgb(59, 130, 246)");
      expect(getComputedStyle(control!).color).toBe("rgb(232, 234, 242)");
    });
  });

  it("uses a real switch with the Pencil track geometry", async () => {
    await render(<SwitchShared aria-label="Enable app" />);

    const control = page.getByRole("switch", { name: "Enable app" });
    const element = control.element() as HTMLButtonElement;
    expect(element.getBoundingClientRect().width).toBe(36);
    expect(element.getBoundingClientRect().height).toBe(20);

    await control.click();
    await expect.element(control).toBeChecked();
  });

  it("preserves native button activation and disabled behavior", async () => {
    const onClick = vi.fn();
    const view = await render(<ButtonPrimary onClick={onClick}>Continue</ButtonPrimary>);

    await page.getByRole("button", { name: "Continue" }).click();
    expect(onClick).toHaveBeenCalledOnce();

    await view.rerender(
      <ButtonPrimary disabled onClick={onClick}>
        Continue
      </ButtonPrimary>,
    );
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../../../theme/theme.logic";

import { OnboardingApps } from "./OnboardingApps";

function resolveCssColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

describe("OnboardingApps", () => {
  beforeEach(() => {
    const theme = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, "dark"), "dark");
    for (const [name, value] of Object.entries(theme.variables)) {
      document.documentElement.style.setProperty(name, value);
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses a real focused search input and filters from typed text", async () => {
    await render(<OnboardingApps />);

    const search = page.getByRole("searchbox", { name: "Search apps" });
    await search.fill("notion");

    await expect.element(search).toHaveValue("notion");
    await expect.element(page.getByText("Notion", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Browser", { exact: true })).not.toBeInTheDocument();
    await search.click();

    const input = search.element() as HTMLInputElement;
    const control = input.closest<HTMLElement>("[data-slot='input-shared']");
    const icon = control?.querySelector<HTMLElement>("span");
    input.focus();
    expect(control).not.toBeNull();
    expect(icon).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      expect(getComputedStyle(control!).borderColor).toBe(
        resolveCssColor(rootStyle.getPropertyValue("--color-border-focus")),
      );
      expect(getComputedStyle(icon!).color).toBe(
        resolveCssColor(rootStyle.getPropertyValue("--color-text-foreground")),
      );
    });
  });

  it("keeps overflow inside the bounded app scroll region", async () => {
    await render(<OnboardingApps />);

    const screen = document.querySelector<HTMLElement>("[data-pencil-component='YmEq2']");
    const viewport = document.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");

    expect(screen).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(screen!.scrollHeight).toBe(screen!.clientHeight);
    expect(viewport!.clientHeight).toBe(300);
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
  });

  it("toggles shared app cards without losing the selection state", async () => {
    await render(<OnboardingApps />);

    const notionToggle = page.getByRole("switch", { name: "Add Notion" });
    await notionToggle.click();
    await expect.element(page.getByRole("switch", { name: "Remove Notion" })).toBeChecked();
  });
});

import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
  type ThemeVariant,
} from "~/theme/theme.logic";
import { PenkraMark } from "./PenkraMark";

const BRAND_VARIABLES = [
  "--color-brand-mark-bridge",
  "--color-brand-mark-glyph",
] as const;

function applyBrandTheme(variant: ThemeVariant) {
  const variables = buildThemeCssVariables(
    resolveThemePack(DEFAULT_THEME_STATE, variant),
    variant,
  ).variables;

  for (const name of BRAND_VARIABLES) {
    document.documentElement.style.setProperty(name, variables[name]);
  }
}

describe("PenkraMark theme behavior", () => {
  afterEach(() => {
    for (const name of BRAND_VARIABLES) {
      document.documentElement.style.removeProperty(name);
    }
    document.body.innerHTML = "";
  });

  it("switches the two-color mark between light and dark surfaces", async () => {
    await render(<PenkraMark aria-label="Penkra" />);

    const mark = page.getByLabelText("Penkra").element();
    const [glyph, bridge] = mark.querySelectorAll("path");

    applyBrandTheme("light");
    expect(getComputedStyle(glyph).fill).toBe("rgb(0, 29, 86)");
    expect(getComputedStyle(bridge).fill).toBe("rgb(140, 184, 225)");

    applyBrandTheme("dark");
    expect(getComputedStyle(glyph).fill).toBe("rgb(245, 245, 247)");
    expect(getComputedStyle(bridge).fill).toBe("rgb(140, 184, 225)");
  });
});

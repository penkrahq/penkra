// FILE: PenkraMark.test.tsx
// Purpose: Prevent the code-rendered Penkra mark from drifting from the Pencil source of truth.
// Layer: web UI tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PenkraMark } from "./PenkraMark";

describe("PenkraMark", () => {
  it("renders the canonical two-color Pencil geometry", () => {
    const markup = renderToStaticMarkup(<PenkraMark aria-label="Penkra" />);

    expect(markup).toContain('viewBox="0 0 512 512"');
    expect(markup).toContain('fill="#F5F5F7"');
    expect(markup).toContain('fill="#8CB8E1"');
    expect(markup).toContain("M89 278v-67");
    expect(markup).toContain("M182 303h78v71");
  });

  it("uses one current color for compact inline contexts", () => {
    const markup = renderToStaticMarkup(<PenkraMark monochrome />);

    expect(markup.match(/fill="currentColor"/gu)).toHaveLength(2);
  });
});

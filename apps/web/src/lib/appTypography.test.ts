import { describe, expect, it } from "vitest";

import { getAppTypographyScale } from "./appTypography";

describe("getAppTypographyScale", () => {
  it("produces exact semantic composer and display sizes at the default scale", () => {
    expect(getAppTypographyScale(12)).toMatchObject({
      composerPx: 14,
      displayLgPx: 28,
      displayMdPx: 26,
      displaySmPx: 24,
    });
  });

  it("keeps semantic sizes on whole pixels when the user changes the base size", () => {
    const scale = getAppTypographyScale(13);
    expect(scale.composerPx).toBe(15);
    expect(scale.displayLgPx).toBe(30);
    expect(scale.displayMdPx).toBe(28);
    expect(scale.displaySmPx).toBe(26);
    for (const size of [
      scale.composerPx,
      scale.displayLgPx,
      scale.displayMdPx,
      scale.displaySmPx,
    ]) {
      expect(Number.isInteger(size)).toBe(true);
    }
  });
});

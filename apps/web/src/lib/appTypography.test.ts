import { describe, expect, it } from "vitest";

import { getAppTypographyScale } from "./appTypography";

describe("getAppTypographyScale", () => {
  it("produces exact semantic composer and display sizes at the default scale", () => {
    expect(getAppTypographyScale(12)).toMatchObject({
      chatPx: 12,
      composerPx: 14,
      displayLgPx: 28,
      displayMdPx: 26,
      displaySmPx: 24,
      uiPx: 12,
    });
  });

  it("keeps ordinary UI labels aligned with transcript text at every scale", () => {
    for (const baseFontSizePx of [10, 12, 14, 16, 18]) {
      const scale = getAppTypographyScale(baseFontSizePx);
      expect(scale.uiPx).toBe(scale.chatPx);
    }
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

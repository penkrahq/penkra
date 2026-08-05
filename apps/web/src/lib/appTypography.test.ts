import { describe, expect, it } from "vitest";

import { getAppTypographyScale } from "./appTypography";

describe("getAppTypographyScale", () => {
  it("produces exact semantic composer and display sizes at the default scale", () => {
    expect(getAppTypographyScale(13)).toMatchObject({
      chatPx: 13,
      composerPx: 13,
      displayLgPx: 30,
      displayMdPx: 28,
      displaySmPx: 26,
      uiPx: 13,
    });
  });

  it("keeps ordinary UI labels and composer text aligned with transcript text at every scale", () => {
    for (const baseFontSizePx of [10, 12, 14, 16, 18]) {
      const scale = getAppTypographyScale(baseFontSizePx);
      expect(scale.uiPx).toBe(scale.chatPx);
      expect(scale.composerPx).toBe(scale.chatPx);
    }
  });

  it("keeps semantic sizes on whole pixels when the user changes the base size", () => {
    const scale = getAppTypographyScale(13);
    expect(scale.composerPx).toBe(13);
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

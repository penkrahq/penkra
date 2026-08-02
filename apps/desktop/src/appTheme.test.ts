import { describe, expect, it } from "vitest";

import { parseDesktopAppTheme, renderDesktopAppThemeCss } from "./appTheme";

const tokens = {
  background: "#181818",
  panel: "#1a1a1a",
  surface: "#202020",
  control: "#292929",
  selected: "#303030",
  overlay: "#1f1f1f",
  textPrimary: "#fff",
  textSecondary: "#aaa",
  textMuted: "#777",
  border: "#333",
  focus: "#4c9dff",
  accent: "#4c9dff",
  success: "#36a269",
  warning: "#d69a2d",
  destructive: "#d84b4b",
  info: "#4c9dff",
  fontSans: "Inter, system-ui, sans-serif",
};

describe("App Theme bridge", () => {
  it("renders only the complete semantic contract", () => {
    const theme = parseDesktopAppTheme({ variant: "dark", tokens });
    expect(renderDesktopAppThemeCss(theme)).toContain("color-scheme:dark");
    expect(renderDesktopAppThemeCss(theme)).toContain("--penkra-color-background:#181818");
  });

  it("rejects CSS statement injection", () => {
    expect(() =>
      parseDesktopAppTheme({
        variant: "dark",
        tokens: { ...tokens, background: "red;}body{display:none" },
      }),
    ).toThrow("background is invalid");
  });
});

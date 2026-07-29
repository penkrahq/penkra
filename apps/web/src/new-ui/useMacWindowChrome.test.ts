import { describe, expect, it } from "vitest";

import {
  MAC_WINDOWED_TITLEBAR_HEIGHT_PX,
  shouldReserveMacWindowedTitlebar,
} from "./useMacWindowChrome";

describe("macOS windowed titlebar", () => {
  it("reserves the Pencil-specified titlebar height in a windowed Electron app", () => {
    expect(MAC_WINDOWED_TITLEBAR_HEIGHT_PX).toBe(46);
    expect(
      shouldReserveMacWindowedTitlebar({
        platform: "MacIntel",
        hasDesktopWindowControls: true,
        isFullscreen: false,
      }),
    ).toBe(true);
  });

  it("returns content to the top edge in macOS fullscreen", () => {
    expect(
      shouldReserveMacWindowedTitlebar({
        platform: "MacIntel",
        hasDesktopWindowControls: true,
        isFullscreen: true,
      }),
    ).toBe(false);
  });

  it("does not reserve native macOS chrome in browsers or on other platforms", () => {
    expect(
      shouldReserveMacWindowedTitlebar({
        platform: "MacIntel",
        hasDesktopWindowControls: false,
        isFullscreen: false,
      }),
    ).toBe(false);
    expect(
      shouldReserveMacWindowedTitlebar({
        platform: "Win32",
        hasDesktopWindowControls: true,
        isFullscreen: false,
      }),
    ).toBe(false);
  });
});

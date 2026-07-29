import { describe, expect, it } from "vitest";

import {
  MAC_WINDOWED_TRAFFIC_LIGHT_GUTTER_PX,
  resolveMacWindowedTrafficLightGutter,
} from "./useMacTrafficLightGutter";

describe("macOS windowed traffic-light affordance", () => {
  it("reserves the Pencil-specified horizontal gutter in a windowed Electron app", () => {
    expect(MAC_WINDOWED_TRAFFIC_LIGHT_GUTTER_PX).toBe(90);
    expect(
      resolveMacWindowedTrafficLightGutter({
        platform: "MacIntel",
        hasDesktopWindowControls: true,
        isFullscreen: false,
        zoomFactor: 1,
      }),
    ).toBe(90);
  });

  it("removes the horizontal gutter in macOS fullscreen", () => {
    expect(
      resolveMacWindowedTrafficLightGutter({
        platform: "MacIntel",
        hasDesktopWindowControls: true,
        isFullscreen: true,
        zoomFactor: 1,
      }),
    ).toBe(0);
  });

  it("inverse-scales the gutter with Electron page zoom", () => {
    expect(
      resolveMacWindowedTrafficLightGutter({
        platform: "MacIntel",
        hasDesktopWindowControls: true,
        isFullscreen: false,
        zoomFactor: 1.5,
      }),
    ).toBe(60);
  });

  it("does not reserve native macOS chrome in browsers or on other platforms", () => {
    expect(
      resolveMacWindowedTrafficLightGutter({
        platform: "Win32",
        hasDesktopWindowControls: true,
        isFullscreen: false,
        zoomFactor: 1,
      }),
    ).toBe(0);
  });
});

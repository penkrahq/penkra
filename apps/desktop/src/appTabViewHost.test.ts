import { describe, expect, it } from "vitest";

import {
  dockTransitionProgress,
  resizedAppTabBounds,
  shouldKeepPresentationAnimation,
  shouldPresentAppView,
} from "./appTabViewHost";

describe("dockTransitionProgress", () => {
  it("matches the shell dock cubic-bezier checkpoints", () => {
    expect(dockTransitionProgress(0)).toBe(0);
    expect(dockTransitionProgress(0.25)).toBeCloseTo(0.7791, 3);
    expect(dockTransitionProgress(0.5)).toBeCloseTo(0.9548, 3);
    expect(dockTransitionProgress(1)).toBe(1);
  });
});

const visible = {
  selected: true,
  attached: true,
  windowVisible: true,
  painted: true,
  threadOnScreen: true,
  bounds: { x: 700, y: 40, width: 500, height: 760 },
};

describe("AppTabViewHost presentation states", () => {
  it.each([
    ["visible", {}, true],
    ["hidden", { selected: false }, false],
    ["zero-bounds", { bounds: { x: 0, y: 0, width: 0, height: 0 } }, false],
    ["detached", { attached: false }, false],
    ["window-hidden", { windowVisible: false }, false],
    ["never-painted", { painted: false }, false],
    ["thread-not-on-screen", { threadOnScreen: false }, false],
  ] as const)("resolves %s", (_name, patch, expected) => {
    expect(shouldPresentAppView({ ...visible, ...patch })).toBe(expected);
  });
});

describe("shouldKeepPresentationAnimation", () => {
  const bounds = { x: 700, y: 40, width: 500, height: 760 };

  it("keeps an in-flight dock reveal when duplicate geometry is published", () => {
    expect(
      shouldKeepPresentationAnimation({
        animating: true,
        ownerWindowId: 9,
        requestedWindowId: 9,
        currentBounds: bounds,
        requestedBounds: { ...bounds },
      }),
    ).toBe(true);
  });

  it("allows a real geometry change to replace the in-flight animation", () => {
    expect(
      shouldKeepPresentationAnimation({
        animating: true,
        ownerWindowId: 9,
        requestedWindowId: 9,
        currentBounds: bounds,
        requestedBounds: { ...bounds, width: bounds.width + 1 },
      }),
    ).toBe(false);
  });
});

describe("resizedAppTabBounds", () => {
  it("preserves the dock's pixel width when leaving a wider fullscreen window", () => {
    expect(
      resizedAppTabBounds({
        bounds: { x: 1600, y: 70, width: 1400, height: 1930 },
        dockWidth: 1400,
        rightInset: 0,
        bottom: 0,
        width: 2048,
        height: 1280,
      }),
    ).toEqual({ x: 648, y: 70, width: 1400, height: 1210 });
  });

  it("clamps the dock width when the resized window is narrower", () => {
    expect(
      resizedAppTabBounds({
        bounds: { x: 600, y: 46, width: 800, height: 754 },
        dockWidth: 800,
        rightInset: 1,
        bottom: 0,
        width: 640,
        height: 480,
      }),
    ).toEqual({ x: 0, y: 46, width: 639, height: 434 });
  });
});

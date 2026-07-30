import { describe, expect, it } from "vitest";

import {
  applySpacePagerEngagement,
  resolveSpacePagerDestination,
  SPACE_PAGER_ACTIVATION_PX,
  SPACE_PAGER_SETTLE_TRANSITION,
} from "./spacePagerPhysics";

describe("spacePagerPhysics", () => {
  it("holds below the activation threshold and ramps toward direct tracking", () => {
    expect(applySpacePagerEngagement(SPACE_PAGER_ACTIVATION_PX - 1)).toBe(0);

    const earlyDistance = applySpacePagerEngagement(16);
    const laterDistance = applySpacePagerEngagement(80);

    expect(earlyDistance).toBeGreaterThan(0);
    expect(earlyDistance).toBeLessThan(8);
    expect(laterDistance).toBeGreaterThan(65);
    expect(laterDistance).toBeLessThan(80);
    expect(applySpacePagerEngagement(-80)).toBe(-laterDistance);
  });

  it("commits a deliberate drag by distance", () => {
    expect(
      resolveSpacePagerDestination({
        activePageIndex: 0,
        dragDistance: 80,
        pageCount: 3,
        pageWidth: 240,
        velocity: 0,
      }),
    ).toBe(1);
  });

  it("commits a short flick using projected velocity", () => {
    expect(
      resolveSpacePagerDestination({
        activePageIndex: 1,
        dragDistance: -30,
        pageCount: 3,
        pageWidth: 240,
        velocity: -0.7,
      }),
    ).toBe(0);
  });

  it("moves at most one page and clamps outer boundaries", () => {
    expect(
      resolveSpacePagerDestination({
        activePageIndex: 1,
        dragDistance: 600,
        pageCount: 4,
        pageWidth: 240,
        velocity: 3,
      }),
    ).toBe(2);
    expect(
      resolveSpacePagerDestination({
        activePageIndex: 0,
        dragDistance: -600,
        pageCount: 4,
        pageWidth: 240,
        velocity: -3,
      }),
    ).toBe(0);
    expect(
      resolveSpacePagerDestination({
        activePageIndex: 3,
        dragDistance: 600,
        pageCount: 4,
        pageWidth: 240,
        velocity: 3,
      }),
    ).toBe(3);
  });

  it("returns to the current page for an uncommitted gesture", () => {
    expect(
      resolveSpacePagerDestination({
        activePageIndex: 1,
        dragDistance: 20,
        pageCount: 3,
        pageWidth: 240,
        velocity: 0.05,
      }),
    ).toBe(1);
  });

  it("uses one duration-based, zero-bounce settle for every release speed", () => {
    expect(SPACE_PAGER_SETTLE_TRANSITION).toEqual({
      bounce: 0,
      type: "spring",
      visualDuration: 0.3,
    });
    expect("velocity" in SPACE_PAGER_SETTLE_TRANSITION).toBe(false);
    expect("stiffness" in SPACE_PAGER_SETTLE_TRANSITION).toBe(false);
  });
});

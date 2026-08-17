import { describe, expect, it } from "vitest";

import { parseAppHostedSurfaceInsets } from "./appHostedSurfaceLayout";

describe("parseAppHostedSurfaceInsets", () => {
  it("accepts a hidden surface or four finite non-negative edges", () => {
    expect(parseAppHostedSurfaceInsets(null)).toBeNull();
    expect(parseAppHostedSurfaceInsets({ top: 84, right: 0, bottom: 0, left: 0 })).toEqual({
      top: 84,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it.each([
    undefined,
    {},
    { top: -1, right: 0, bottom: 0, left: 0 },
    { top: 0, right: Number.NaN, bottom: 0, left: 0 },
    { top: 0, right: 0, bottom: Number.POSITIVE_INFINITY, left: 0 },
  ])("rejects invalid surface geometry %#", (value) => {
    expect(() => parseAppHostedSurfaceInsets(value)).toThrow(/surface/i);
  });
});
